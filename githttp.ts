// The git smart-HTTP surface: /<owner>/<repo>.git/info/refs, git-upload-pack and
// git-receive-pack, speaking protocol v0 and v2 exactly as the suite's git client drives
// them: v2 capability advertisement and ls-refs, v2/v0 fetch with shallow and deepen,
// receive-pack with report-status in side-band-64k and per-ref non-fast-forward refusals.

import type { RepoRec } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
} from './gitobj.ts';
import type { GitObjectRec } from './gitobj.ts';
import { messageReply } from './web.ts';
import type { ReqCtx, Reply } from './web.ts';

const AGENT = 'makefun-forge/1.0';
type Objects = Map<string, GitObjectRec>;

// ---------------------------------------------------------------------------------------------
// Advertisements

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function v0Advertisement(repo: RepoRec, service: string): Buffer {
  const caps = service === 'git-receive-pack'
    ? `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`
    : `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\u0000${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(encodePktLine(`${oid} ${name}\n`));
      const target = repo.objects.get(oid);
      if (target !== undefined && target.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled !== null) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('server-option\n'),
    encodePktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Fetch planning

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

/** Reachable objects from tips, never descending into the parents of a stop-set commit. */
function reachableWithStops(objects: Objects, tips: Iterable<string>, stops: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      if (!stops.has(oid)) {
        const commit = parseCommit(object.data);
        stack.push(commit.tree, ...commit.parents);
      } else {
        stack.push(parseCommit(object.data).tree);
      }
    } else if (object.type === 'tree') {
      // Trees are walked through parseTree-free recursion via collectReachable below.
      for (const child of collectReachable(objects, [oid])) seen.add(child);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

function planFetch(repo: RepoRec, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const objects = repo.objects;
  const knownHaves = haves.filter((oid) => objects.has(oid));
  const haveClosure = collectReachable(objects, knownHaves);
  const commonHaves = knownHaves.filter((oid) => objects.get(oid)?.type === 'commit');

  if (depth === null) {
    const stops = new Set(clientShallow);
    const included = reachableWithStops(objects, wants, stops);
    for (const oid of haveClosure) included.delete(oid);
    const packObjects = [...included].map((oid) => objects.get(oid)!).filter(Boolean);
    return { pack: writePack(packObjects), shallow: [], unshallow: [], commonHaves };
  }

  // Depth-limited: assign each wanted commit a level (want = 1), walk parents while level < depth.
  const levels = new Map<string, number>();
  const tagObjects = new Set<string>();
  const queue: { oid: string; level: number }[] = [];
  for (const want of wants) {
    let current = want;
    // Peel tag chains into the pack, landing on the commit.
    for (let hops = 0; hops < 32; hops += 1) {
      const object = objects.get(current);
      if (object === undefined) break;
      if (object.type === 'tag') {
        tagObjects.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') queue.push({ oid: current, level: 1 });
      break;
    }
  }
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    if (level > depth) continue;
    const known = levels.get(oid);
    if (known !== undefined && known <= level) continue;
    levels.set(oid, level);
    if (level < depth) {
      const object = objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, level: level + 1 });
      }
    }
  }
  const included = new Set<string>(tagObjects);
  for (const oid of levels.keys()) {
    included.add(oid);
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const child of collectReachable(objects, [parseCommit(object.data).tree])) included.add(child);
    }
  }
  const shallow: string[] = [];
  for (const [oid, level] of levels) {
    if (level !== depth) continue;
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
  }
  const shallowSet = new Set(shallow);
  const unshallow = clientShallow.filter((oid) => levels.has(oid) && !shallowSet.has(oid));
  // Subtract only what the client provably holds: the closure of its haves, but never
  // descending past the parents of a commit the client holds shallow — those ancestors are
  // exactly what a deepen request is asking for.
  const heldByClient = reachableWithStops(objects, knownHaves, new Set(clientShallow));
  for (const oid of heldByClient) included.delete(oid);
  const packObjects = [...included].map((oid) => objects.get(oid)!).filter(Boolean);
  return { pack: writePack(packObjects), shallow, unshallow, commonHaves };
}

/** Chunk a pack into side-band-64k pkt-lines (band 1), each safely under the pkt-line cap. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32000;
  if (pack.length === 0) return parts;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

function lsRefs(repo: RepoRec, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (prefixes.length === 0) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:${target}` : `${headOid} HEAD`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${target}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => encodePktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// Request parsing

interface V2Request {
  command: string;
  args: string[];
}

/** Parse a protocol-v2 request body: command section, delim, argument section, flush. */
function parseV2Request(body: Buffer): V2Request | null {
  const { packets } = decodePktLines(body);
  const commandLines: string[] = [];
  const args: string[] = [];
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) commandLines.push(line);
    else args.push(line);
  }
  const commandLine = commandLines.find((line) => line.startsWith('command='));
  if (commandLine === undefined) return null;
  return { command: commandLine.slice('command='.length), args };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number.parseInt(arg.slice(7), 10);
  }
  return out;
}

/** Parse a v0 upload-pack request: wants section, flush, haves section, flush. */
function parseV0Fetch(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) out.wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) out.depth = Number.parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) {
      out.haves.push(line.slice(5).trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The handler

/** Handle one git smart-HTTP request. The repo is already resolved (or undefined). */
export function handleGitHttp(ctx: ReqCtx, repo: RepoRec | undefined, service: string, tail: string): Reply {
  if (repo === undefined) return messageReply(404, 'Not Found');

  if (tail === 'info/refs' && ctx.method === 'GET') {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return messageReply(400, 'Bad service');
    const wantsV2 = (ctx.headers['git-protocol'] ?? '').toString().includes('version=2');
    if (service === 'git-upload-pack' && wantsV2) {
      return { status: 200, raw: v2Advertisement(), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    return {
      status: 200,
      raw: v0Advertisement(repo, service),
      contentType: `application/x-${service}-advertisement`,
    };
  }

  if (tail === 'git-upload-pack' && ctx.method === 'POST') {
    const wantsV2 = (ctx.headers['git-protocol'] ?? '').toString().includes('version=2');
    if (wantsV2) {
      const request = parseV2Request(ctx.body);
      if (request === null) return { status: 400, raw: Buffer.from('bad request\n'), contentType: 'text/plain' };
      if (request.command === 'ls-refs') {
        return { status: 200, raw: lsRefs(repo, request.args), contentType: 'application/x-git-upload-pack-result' };
      }
      if (request.command === 'fetch') {
        const args = parseFetchArgs(request.args);
        const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
        const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
        if (plan.commonHaves.length > 0) {
          for (const have of plan.commonHaves) parts.push(encodePktLine(`ACK ${have} common\n`));
          parts.push(encodePktLine('ready\n'));
        } else {
          parts.push(encodePktLine('NAK\n'));
        }
        parts.push(PKT_DELIM);
        if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
          parts.push(encodePktLine('shallow-info\n'));
          for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
          for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
          parts.push(PKT_DELIM);
        }
        parts.push(encodePktLine('packfile\n'));
        parts.push(...sidebandPackets(plan.pack));
        parts.push(PKT_FLUSH);
        return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
      }
      return { status: 400, raw: Buffer.from('unknown command\n'), contentType: 'text/plain' };
    }
    // Protocol v0 fetch.
    const args = parseV0Fetch(ctx.body);
    if (args.wants.length === 0) return { status: 400, raw: Buffer.from('bad request\n'), contentType: 'text/plain' };
    const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
    const parts: Buffer[] = [];
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(encodePktLine('NAK\n'));
    parts.push(...sidebandPackets(plan.pack));
    parts.push(PKT_FLUSH);
    return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
  }

  if (tail === 'git-receive-pack' && ctx.method === 'POST') {
    return receivePack(repo, ctx.body);
  }

  return messageReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): Reply {
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) return { status: 400, raw: Buffer.from('bad request\n'), contentType: 'text/plain' };

  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const staged = readPack(rest, repo.objects);
      for (const [oid, object] of staged) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }

  const target = headTarget(repo);
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (command.ref === target) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined) {
      fail('invalid object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        fail('object is not a commit');
        continue;
      }
      if (command.oldOid !== ZERO_OID && !isAncestor(repo.objects, command.oldOid, command.newOid)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), PKT_FLUSH]);
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  if (caps.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 32000;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      const chunk = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-result' };
  }
  return { status: 200, raw: inner, contentType: 'application/x-git-receive-pack-result' };
}
