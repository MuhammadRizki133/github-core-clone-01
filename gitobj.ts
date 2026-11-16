// The git object model, from scratch on node:crypto/node:zlib: SHA-1 object ids, loose-object
// framing, tree/commit/tag parsing and building, packfile reading (with OFS/REF delta
// resolution) and writing (plain objects), the pkt-line codec, reachability walks, tree
// flattening/diffing and merge-base search. No git binary is involved anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER } from './store.ts';
import type { GitObjectRec, RepoRec } from './store.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in a repo (or a staging map) and return its id. */
export function putObject(store: Map<string, GitObjectRec>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree ordering: by name, with directories compared as if the name ended in "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel an object id through tag objects to the commit it ultimately names (or null). */
export function peelToCommit(objects: Map<string, GitObjectRec>, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reachability

/** Every object reachable from the given tips (commits walk parents and trees; tags peel). */
export function collectReachable(objects: Map<string, GitObjectRec>, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents. */
export function isAncestor(objects: Map<string, GitObjectRec>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** All ancestors of a commit (including itself), newest-first by breadth. */
export function ancestorsOf(objects: Map<string, GitObjectRec>, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    order.push(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return order;
}

/** The best common ancestor of two commits, or null when they share no history. */
export function mergeBase(objects: Map<string, GitObjectRec>, a: string, b: string): string | null {
  const ancestorsA = new Set(ancestorsOf(objects, a));
  for (const candidate of ancestorsOf(objects, b)) {
    if (ancestorsA.has(candidate)) return candidate;
  }
  return null;
}

/** Commits reachable from `tip`, newest first (the /commits list walk). */
export function commitHistory(objects: Map<string, GitObjectRec>, tip: string): string[] {
  return ancestorsOf(objects, tip);
}

// ---------------------------------------------------------------------------------------------
// Tree flattening, applying changes, diffing

/** Flatten a tree (recursively) to a map of path -> blob oid. */
export function flattenTree(objects: Map<string, GitObjectRec>, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (treeOid === EMPTY_TREE_OID) return out;
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/**
 * Apply file changes (path -> new bytes, or null to delete) on top of a base tree, storing every
 * new blob and tree. Returns the new tree's oid.
 */
export function applyChanges(
  objects: Map<string, GitObjectRec>,
  baseTreeOid: string,
  changes: ReadonlyMap<string, Buffer | null>,
): string {
  const flat = flattenTree(objects, baseTreeOid);
  for (const [path, bytes] of changes) {
    if (bytes === null) flat.delete(path);
    else flat.set(path, putObject(objects, 'blob', bytes));
  }
  return buildTreeFromFlat(objects, flat);
}

/** Rebuild nested trees from a flattened path -> blob oid map. */
export function buildTreeFromFlat(objects: Map<string, GitObjectRec>, flat: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    if (entries.length === 0) return EMPTY_TREE_OID;
    return putObject(objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The paths whose blob differs between two flattened trees, mapped to the new blob (or null). */
export function diffFlat(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Map<string, string | null> {
  const diff = new Map<string, string | null>();
  for (const [path, oid] of after) {
    if (before.get(path) !== oid) diff.set(path, oid);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) diff.set(path, null);
  }
  return diff;
}

// ---------------------------------------------------------------------------------------------
// Line diffs (for pull request file statistics)

function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Addition/deletion counts between two file bodies, via a longest-common-subsequence walk. */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS lengths over suffixes; the inputs are small (scenario texts), a full table is fine.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + (j + 1)]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + (j + 1)]!);
    }
  }
  const common = table[0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------------------------------------
// Packfiles

function encodeObjectHeader(type: GitObjectType, size: number): Buffer {
  let value = size;
  const bytes: number[] = [(TYPE_CODE[type] << 4) | (value & 0x0f)];
  value >>= 4;
  while (value > 0) {
    bytes[bytes.length - 1]! |= 0x80;
    bytes.push(value & 0x7f);
    value >>= 7;
  }
  return Buffer.from(bytes);
}

/** Write a version-2 pack of plain (undeltified) objects, sorted by id for determinism. */
export function writePack(objects: Iterable<GitObjectRec & { oid?: string }>): Buffer {
  const list: { oid: string; type: GitObjectType; data: Buffer }[] = [];
  for (const object of objects) {
    list.push({ oid: object.oid ?? hashObject(object.type, object.data), type: object.type, data: object.data });
  }
  list.sort((x, y) => (x.oid < y.oid ? -1 : x.oid > y.oid ? 1 : 0));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(encodeObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/**
 * Read a packfile into objects, resolving deltas against the pack itself and, for REF_DELTA,
 * against `external` (objects the caller already holds). Returns id -> object.
 */
export function readPack(pack: Buffer, external?: Map<string, GitObjectRec>): Map<string, GitObjectRec> {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum does not verify');

  const entries: { offset: number; entry: PackEntry }[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (code === 6) {
      // OFS_DELTA: a variable-length negative offset to the base entry.
      let back = pack[offset]!;
      offset += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateSync(pack.subarray(offset));
      entry = { type: 'ofs-delta', data: inflated, baseOffset: start - baseOffset };
      offset += compressedLength(pack, offset, inflated.length);
    } else if (code === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset));
      entry = { type: 'ref-delta', data: inflated, baseOid };
      offset += compressedLength(pack, offset, inflated.length);
    } else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`pack entry has unknown type code ${code}`);
      const inflated = inflateSync(pack.subarray(offset));
      if (inflated.length !== size) throw new Error('pack entry size mismatch');
      entry = { type, data: inflated };
      offset += compressedLength(pack, offset, inflated.length);
    }
    entries.push({ offset: start, entry });
  }

  const byOffset = new Map<number, GitObjectRec>();
  const resolved = new Map<string, GitObjectRec>();
  const resolveOne = (entry: PackEntry): GitObjectRec | null => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      return { type: entry.type, data: entry.data };
    }
    let base: GitObjectRec | undefined;
    if (entry.type === 'ofs-delta') base = byOffset.get(entry.baseOffset!);
    else base = resolved.get(entry.baseOid!) ?? external?.get(entry.baseOid!);
    if (base === undefined) return null;
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };
  // Resolve in passes: plain objects first, then deltas whose bases are ready, until done.
  const pending = new Map(entries.map((item) => [item.offset, item.entry]));
  while (pending.size > 0) {
    let progressed = false;
    for (const [entryOffset, entry] of pending) {
      const object = resolveOne(entry);
      if (object === null) continue;
      byOffset.set(entryOffset, object);
      resolved.set(hashObject(object.type, object.data), object);
      pending.delete(entryOffset);
      progressed = true;
    }
    if (!progressed) throw new Error('pack has a delta whose base is not available');
  }
  return resolved;
}

/** The compressed length of the zlib stream starting at `offset` (found by inflating). */
function compressedLength(pack: Buffer, offset: number, inflatedLength: number): number {
  // Inflate a growing window until it yields the expected bytes; streams here are small.
  let end = Math.min(pack.length, offset + Math.max(64, inflatedLength * 2 + 64));
  for (;;) {
    try {
      const out = inflateSync(pack.subarray(offset, end));
      if (out.length === inflatedLength) {
        // zlib streams are self-terminating; the exact consumed length is found by trimming:
        // binary-search the smallest end that still inflates fully.
        let lo = offset + 10;
        let hi = end;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          try {
            const trial = inflateSync(pack.subarray(offset, mid));
            if (trial.length === inflatedLength) hi = mid;
            else lo = mid + 1;
          } catch {
            lo = mid + 1;
          }
        }
        return lo - offset;
      }
    } catch {
      // need more bytes
    }
    if (end >= pack.length) throw new Error('pack entry does not inflate');
    end = Math.min(pack.length, end * 2);
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** One decoded pkt-line: a data payload, or a control marker. */
export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode every complete pkt-line in a buffer; returns the packets and the unconsumed tail. */
export function decodePktLines(bytes: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

// ---------------------------------------------------------------------------------------------
// Repository-level helpers shared by the HTTP surfaces

/** Resolve a ref-ish string (branch name, full ref, tag, sha) to a commit oid, or null. */
export function resolveToCommit(repo: RepoRec, ref: string): string | null {
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return peelToCommit(repo.objects, oid);
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return peelToCommit(repo.objects, ref);
  return null;
}

/** Resolve a ref-ish string to any object id (no peeling), or null. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return oid;
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** The full ref name for a branch, creating the "refs/heads/" prefix form. */
export function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** The tree oid of a commit. */
export function treeOfCommit(objects: Map<string, GitObjectRec>, commitOid: string): string {
  const object = objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return EMPTY_TREE_OID;
  return parseCommit(object.data).tree;
}

/** An ident line for commits the forge itself authors (contents API, merges). */
export function forgeIdent(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}
