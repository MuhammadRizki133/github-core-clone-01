// The REST v3 surface: /api/v3 root and meta, the viewer, repositories and their contents,
// branches, commits, git refs, labels, issues with comments, and pull requests with files
// and merging. Response shapes follow GitHub's; the checks' exact expectations (statuses,
// {message} error bodies, Link pagination, contents sha rules) are honoured throughout.

import { VIEWER, repoGlobalId, issueGlobalId, pullGlobalId, commentGlobalId, userGlobalId } from './store.ts';
import type { CommentRec, IssueRec, PullRec, RepoRec, Store } from './store.ts';
import {
  EMPTY_TREE_OID,
  commitHistory,
  hashObject,
  parseCommit,
  parseTree,
  resolveToCommit,
  treeOfCommit,
} from './gitobj.ts';
import { branchTip, commitOnBranch, createIssue, createPull, flatAtCommit, mergePull, pullFiles } from './domain.ts';
import { decodeSeg, jsonBody, jsonReply, messageReply, paginate, strField } from './web.ts';
import type { ReqCtx, Reply } from './web.ts';

// ---------------------------------------------------------------------------------------------
// Serializers

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: userGlobalId(),
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
    avatar_url: '',
    html_url: `https://forge.local/${VIEWER.login}`,
    url: '',
  };
}

function repoJson(ctx: ReqCtx, repo: RepoRec): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER.id, node_id: userGlobalId(), type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ctx.store.isoAt(repo.createdSeq),
    updated_at: ctx.store.isoAt(repo.createdSeq),
    pushed_at: ctx.store.isoAt(repo.createdSeq),
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://forge.local/${repo.owner}/${repo.name}.git`,
    clone_url: `${ctx.origin}/${repo.owner}/${repo.name}.git`,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    size: 0,
    language: null,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name)!;
  const id = [...repo.labels.keys()].indexOf(name) + 1;
  return { id, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(ctx: ReqCtx, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.seq,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, node_id: userGlobalId(), type: 'User' },
    comments: issue.comments.length,
    created_at: ctx.store.isoAt(issue.createdSeq),
    updated_at: ctx.store.isoAt(issue.createdSeq),
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function commentJson(ctx: ReqCtx, repo: RepoRec, issue: IssueRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.seq,
    node_id: commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, node_id: userGlobalId(), type: 'User' },
    created_at: ctx.store.isoAt(comment.createdSeq),
    updated_at: ctx.store.isoAt(comment.createdSeq),
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.seq}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.seq}`,
    issue_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(ctx: ReqCtx, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  return {
    id: pull.seq,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER.login, id: VIEWER.id, node_id: userGlobalId(), type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : ctx.store.isoAt(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: ctx.store.isoAt(pull.createdSeq),
    updated_at: ctx.store.isoAt(pull.mergedSeq ?? pull.createdSeq),
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Contents helpers

/** Wrap base64 the way GitHub does: 60-character lines. */
function wrapBase64(bytes: Buffer): string {
  const raw = bytes.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 60) lines.push(raw.slice(i, i + 60));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[\s]+/g, ''), 'base64');
}

/** The entries of the directory at `dirPath` ("" for the root) in a tree, or null. */
function dirEntries(repo: RepoRec, treeOid: string, dirPath: string): { name: string; path: string; type: string; sha: string; size: number }[] | null {
  let current = treeOid;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const tree = repo.objects.get(current);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return null;
      current = entry.oid;
    }
  }
  if (current === EMPTY_TREE_OID) return [];
  const tree = repo.objects.get(current);
  if (tree === undefined || tree.type !== 'tree') return null;
  return parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      type: isDir ? 'dir' : 'file',
      sha: entry.oid,
      size: isDir || blob === undefined ? 0 : blob.data.length,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The router

/** Handle one /api/v3 request (auth already verified by app.ts). */
export function handleRest(ctx: ReqCtx): Reply {
  const store = ctx.store;
  const rest = ctx.path.slice('/api/v3'.length);
  const segments = rest.split('/').filter((part) => part !== '').map(decodeSeg);

  if (rest === '' || rest === '/') {
    if (ctx.method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, {
      current_user_url: `${ctx.origin}/api/v3/user`,
      current_user_repositories_url: `${ctx.origin}/api/v3/user/repos`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      issue_search_url: `${ctx.origin}/api/v3/search/issues`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (ctx.method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, { installed_version: '1.0.0', git_enabled: true });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (ctx.method !== 'GET') return messageReply(404, 'Not Found');
    return jsonReply(200, { ...userJson(), url: `${ctx.origin}/api/v3/user` });
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (ctx.method === 'GET') {
      const page = paginate(ctx, store.allRepos(), '/api/v3/user/repos');
      return jsonReply(200, page.items.map((repo) => repoJson(ctx, repo)), page.link === null ? undefined : { link: page.link });
    }
    if (ctx.method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const name = strField(parsed.value, 'name');
      if (name === undefined || name === '') return messageReply(422, 'Validation Failed: name is required');
      if (store.repo(VIEWER.login, name) !== undefined) return messageReply(422, 'name already exists on this account');
      const isPrivate = typeof parsed.value.private === 'boolean' ? parsed.value.private : false;
      const description = strField(parsed.value, 'description') ?? '';
      const repo = store.createRepo(name, isPrivate, description);
      return jsonReply(201, repoJson(ctx, repo));
    }
    return messageReply(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return messageReply(404, 'Not Found');
  const repo = store.repo(segments[1]!, segments[2]!);
  if (repo === undefined) return messageReply(404, 'Not Found');
  const tail = segments.slice(3);
  return handleRepo(ctx, repo, tail);
}

function handleRepo(ctx: ReqCtx, repo: RepoRec, tail: string[]): Reply {
  const store: Store = ctx.store;

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (ctx.method === 'GET') return jsonReply(200, repoJson(ctx, repo));
    if (ctx.method === 'PATCH') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const description = strField(parsed.value, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      return jsonReply(200, repoJson(ctx, repo));
    }
    if (ctx.method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204 };
    }
    return messageReply(404, 'Not Found');
  }

  // /branches[/...]
  if (tail[0] === 'branches') {
    if (ctx.method !== 'GET') return messageReply(404, 'Not Found');
    if (tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return jsonReply(200, branches);
    }
    const name = tail.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (sha === undefined) return messageReply(404, 'Not Found');
    return jsonReply(200, { name, commit: { sha }, protected: false });
  }

  // /git/refs[/...]
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (ctx.method === 'POST' && tail.length === 2) {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const ref = strField(parsed.value, 'ref');
      const sha = strField(parsed.value, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return messageReply(422, 'Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return messageReply(422, 'Reference already exists');
      const target = repo.objects.get(sha);
      if (target === undefined) return messageReply(422, 'Validation Failed: sha does not name an object');
      repo.refs.set(ref, sha);
      return jsonReply(201, { ref, node_id: '', object: { sha, type: target.type } });
    }
    if (ctx.method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return messageReply(404, 'Not Found');
      const target = repo.objects.get(sha);
      return jsonReply(200, { ref, node_id: '', object: { sha, type: target?.type ?? 'commit' } });
    }
    return messageReply(404, 'Not Found');
  }

  // /commits
  if (tail[0] === 'commits' && tail.length === 1) {
    if (ctx.method !== 'GET') return messageReply(404, 'Not Found');
    const wanted = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveToCommit(repo, wanted);
    if (tip === null) return jsonReply(200, []);
    const history = commitHistory(repo.objects, tip);
    const items = history.map((sha) => {
      const object = repo.objects.get(sha)!;
      const commit = parseCommit(object.data);
      const ident = (line: string): Record<string, unknown> => {
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
        return {
          name: match?.[1] ?? '',
          email: match?.[2] ?? '',
          date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        };
      };
      return {
        sha,
        node_id: '',
        commit: {
          author: ident(commit.author),
          committer: ident(commit.committer),
          message: commit.message,
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        html_url: `${ctx.origin}/${repo.owner}/${repo.name}/commit/${sha}`,
        url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      };
    });
    const page = paginate(ctx, items, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
    return jsonReply(200, page.items, page.link === null ? undefined : { link: page.link });
  }

  // /contents[/<path>]
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    return handleContents(ctx, repo, path);
  }

  // /labels[/<name>]
  if (tail[0] === 'labels') {
    if (ctx.method === 'GET' && tail.length === 1) {
      return jsonReply(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    }
    if (ctx.method === 'POST' && tail.length === 1) {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const name = strField(parsed.value, 'name');
      if (name === undefined || name === '') return messageReply(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return messageReply(422, 'Validation Failed: a label with this name already exists');
      const color = (strField(parsed.value, 'color') ?? 'ededed').replace(/^#/, '');
      const description = strField(parsed.value, 'description') ?? '';
      repo.labels.set(name, { name, color, description });
      return jsonReply(201, labelJson(repo, name));
    }
    if (ctx.method === 'GET' && tail.length === 2) {
      const name = tail[1]!;
      if (!repo.labels.has(name)) return messageReply(404, 'Not Found');
      return jsonReply(200, labelJson(repo, name));
    }
    return messageReply(404, 'Not Found');
  }

  // /issues[/...]
  if (tail[0] === 'issues') return handleIssues(ctx, repo, tail.slice(1));

  // /pulls[/...]
  if (tail[0] === 'pulls') return handlePulls(ctx, repo, tail.slice(1));

  return messageReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Contents

function handleContents(ctx: ReqCtx, repo: RepoRec, path: string): Reply {
  const store = ctx.store;

  if (ctx.method === 'GET') {
    const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = resolveToCommit(repo, ref);
    if (tip === null) return messageReply(404, 'Not Found');
    const flat = flatAtCommit(repo, tip);
    const blobOid = flat.get(path);
    if (path !== '' && blobOid !== undefined) {
      const blob = repo.objects.get(blobOid)!;
      return jsonReply(200, {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: blob.data.length,
        encoding: 'base64',
        content: wrapBase64(blob.data),
      });
    }
    const entries = dirEntries(repo, treeOfCommit(repo.objects, tip), path);
    if (entries === null) return messageReply(404, 'Not Found');
    return jsonReply(200, entries.map((entry) => ({
      type: entry.type,
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
    })));
  }


  if (ctx.method === 'PUT') {
    const parsed = jsonBody(ctx);
    if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
    if (path === '') return messageReply(422, 'Validation Failed: no path given');
    const content = strField(parsed.value, 'content');
    if (content === undefined) return messageReply(422, 'Validation Failed: content is required');
    const message = strField(parsed.value, 'message') ?? '';
    const branch = strField(parsed.value, 'branch') ?? repo.defaultBranch;
    const givenSha = strField(parsed.value, 'sha');
    const baseTip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
    const flat = baseTip === null ? new Map<string, string>() : flatAtCommit(repo, baseTip);
    const existing = flat.get(path);
    if (existing !== undefined) {
      if (givenSha === undefined) return messageReply(422, "Validation Failed: sha wasn't supplied");
      if (givenSha !== existing) return messageReply(409, 'Conflict: the sha does not match the current content');
    }
    const bytes = decodeBase64(content);
    const commitSha = commitOnBranch(store, repo, branch, new Map([[path, bytes]]), message);
    const contentSha = hashObject('blob', bytes);
    return jsonReply(existing === undefined ? 201 : 200, {
      content: {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: contentSha,
        size: bytes.length,
        encoding: 'base64',
      },
      commit: { sha: commitSha },
    });
  }

  if (ctx.method === 'DELETE') {
    const parsed = jsonBody(ctx);
    if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
    const message = strField(parsed.value, 'message') ?? '';
    const branch = strField(parsed.value, 'branch') ?? repo.defaultBranch;
    const givenSha = strField(parsed.value, 'sha');
    const tip = branchTip(repo, branch);
    if (tip === null) return messageReply(404, 'Not Found');
    const flat = flatAtCommit(repo, tip);
    const existing = flat.get(path);
    if (existing === undefined) return messageReply(404, 'Not Found');
    if (givenSha !== undefined && givenSha !== existing) return messageReply(409, 'Conflict: the sha does not match the current content');
    const commitSha = commitOnBranch(store, repo, branch, new Map<string, Buffer | null>([[path, null]]), message);
    return jsonReply(200, { content: null, commit: { sha: commitSha } });
  }

  return messageReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Issues

function handleIssues(ctx: ReqCtx, repo: RepoRec, tail: string[]): Reply {
  const store = ctx.store;

  if (tail.length === 0) {
    if (ctx.method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const title = strField(parsed.value, 'title');
      if (title === undefined) return messageReply(422, 'Validation Failed: title is required');
      const body = strField(parsed.value, 'body') ?? '';
      const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return messageReply(422, `Validation Failed: label '${label}' was not found`);
      }
      const issue = createIssue(store, repo, { title, body, labels });
      return jsonReply(201, issueJson(ctx, repo, issue));
    }
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
      const page = paginate(ctx, issues, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return jsonReply(200, page.items.map((issue) => issueJson(ctx, repo, issue)), page.link === null ? undefined : { link: page.link });
    }
    return messageReply(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0]!, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) return messageReply(404, 'Not Found');

  if (tail.length === 1) {
    if (ctx.method === 'GET') return jsonReply(200, issueJson(ctx, repo, issue));
    if (ctx.method === 'PATCH') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const state = strField(parsed.value, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = strField(parsed.value, 'title');
      if (title !== undefined) issue.title = title;
      const body = strField(parsed.value, 'body');
      if (body !== undefined) issue.body = body;
      if (Array.isArray(parsed.value.labels)) {
        const labels = parsed.value.labels.filter((x): x is string => typeof x === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return messageReply(422, `Validation Failed: label '${label}' was not found`);
        }
        issue.labels = labels;
      }
      return jsonReply(200, issueJson(ctx, repo, issue));
    }
    return messageReply(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (ctx.method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const body = strField(parsed.value, 'body');
      if (body === undefined) return messageReply(422, 'Validation Failed: body is required');
      const comment: CommentRec = { seq: store.nextCommentSeq(), body, createdSeq: store.tick() };
      issue.comments.push(comment);
      return jsonReply(201, commentJson(ctx, repo, issue, comment));
    }
    if (ctx.method === 'GET') {
      const page = paginate(ctx, issue.comments, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`);
      return jsonReply(200, page.items.map((comment) => commentJson(ctx, repo, issue, comment)), page.link === null ? undefined : { link: page.link });
    }
  }

  return messageReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Pull requests

function handlePulls(ctx: ReqCtx, repo: RepoRec, tail: string[]): Reply {
  const store = ctx.store;

  if (tail.length === 0) {
    if (ctx.method === 'POST') {
      const parsed = jsonBody(ctx);
      if (!parsed.ok) return messageReply(400, 'Problems parsing JSON');
      const title = strField(parsed.value, 'title');
      const body = strField(parsed.value, 'body') ?? '';
      const stripOwner = (value: string): string => (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);
      const headRaw = strField(parsed.value, 'head');
      const baseRaw = strField(parsed.value, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        return messageReply(422, 'Validation Failed: title, head and base are required');
      }
      const head = stripOwner(headRaw);
      const base = stripOwner(baseRaw);
      const headTip = branchTip(repo, head);
      const baseTipSha = branchTip(repo, base);
      if (headTip === null) return messageReply(422, `Validation Failed: head ref '${head}' does not exist`);
      if (baseTipSha === null) return messageReply(422, `Validation Failed: base ref '${base}' does not exist`);
      if (head === base) return messageReply(422, 'Validation Failed: head and base are the same');
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return messageReply(422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
      if (headTip === baseTipSha) return messageReply(422, `Validation Failed: no commits between ${base} and ${head}`);
      const pull = createPull(store, repo, { title, body, head, base });
      return jsonReply(201, pullJson(ctx, repo, pull));
    }
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const page = paginate(ctx, pulls, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return jsonReply(200, page.items.map((pull) => pullJson(ctx, repo, pull)), page.link === null ? undefined : { link: page.link });
    }
    return messageReply(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0]!, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return messageReply(404, 'Not Found');

  if (tail.length === 1 && ctx.method === 'GET') return jsonReply(200, pullJson(ctx, repo, pull));

  if (tail.length === 2 && tail[1] === 'files' && ctx.method === 'GET') {
    const files = pullFiles(repo, pull).map((file) => {
      const flat = flatAtCommit(repo, branchTip(repo, pull.headRef) ?? pull.headSha);
      return {
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: flat.get(file.filename) ?? '',
      };
    });
    const page = paginate(ctx, files, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/files`);
    return jsonReply(200, page.items, page.link === null ? undefined : { link: page.link });
  }

  if (tail.length === 2 && tail[1] === 'merge' && ctx.method === 'PUT') {
    const outcome = mergePull(store, repo, pull);
    if (!outcome.ok) {
      if (outcome.reason === 'missing') return messageReply(404, 'Not Found');
      return messageReply(405, 'Pull Request is not mergeable');
    }
    return jsonReply(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return messageReply(404, 'Not Found');
}
