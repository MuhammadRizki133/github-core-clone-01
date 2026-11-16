// Domain operations shared by the REST, GraphQL and MCP surfaces, so every surface sees the
// same objects: contents-API commits, issue/pull creation, pull-request diffing and merging.

import type { IssueRec, PullRec, RepoRec, Store } from './store.ts';
import {
  EMPTY_TREE_OID,
  applyChanges,
  buildCommit,
  buildTreeFromFlat,
  diffFlat,
  flattenTree,
  forgeIdent,
  lineDiff,
  mergeBase,
  parseCommit,
  putObject,
  treeOfCommit,
} from './gitobj.ts';

/** The tip commit of a branch, or null when the branch does not exist or is unborn. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/**
 * Commit file changes on a branch, creating the branch when it does not exist yet (from the
 * default branch's tip, or as a root commit when the repository is empty). Mirrors the
 * contents API's behaviour. Returns the new commit's id.
 */
export function commitOnBranch(
  store: Store,
  repo: RepoRec,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref) ?? null;
  if (parent === null && branch !== repo.defaultBranch) {
    parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const baseTree = parent === null ? EMPTY_TREE_OID : treeOfCommit(repo.objects, parent);
  const tree = applyChanges(repo.objects, baseTree, changes);
  const ident = forgeIdent(store.epochSec());
  const data = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    author: ident,
    committer: ident,
    message,
  });
  const sha = putObject(repo.objects, 'commit', data);
  repo.refs.set(ref, sha);
  store.tick();
  return sha;
}

/** The flattened path -> blob id map at a commit. */
export function flatAtCommit(repo: RepoRec, commitSha: string): Map<string, string> {
  return flattenTree(repo.objects, treeOfCommit(repo.objects, commitSha));
}

/** The blob bytes at a path in a flattened tree, or null. */
export function blobBytes(repo: RepoRec, flat: ReadonlyMap<string, string>, path: string): Buffer | null {
  const oid = flat.get(path);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  return object === undefined ? null : object.data;
}

// ---------------------------------------------------------------------------------------------
// Issues

export function createIssue(
  store: Store,
  repo: RepoRec,
  input: { title: string; body: string; labels: string[] },
): IssueRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    number,
    seq: store.nextIssueSeq(),
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    createdSeq: store.tick(),
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

// ---------------------------------------------------------------------------------------------
// Pull requests

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The merge-base of a pull request's head and base tips (recomputed live), or null. */
export function pullMergeBase(repo: RepoRec, pull: PullRec): string | null {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return mergeBase(repo.objects, baseTip, headTip);
}

/** The changed files of a pull request: merge-base tree versus head tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): PullFile[] {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const base = pullMergeBase(repo, pull);
  const before = base === null ? new Map<string, string>() : flatAtCommit(repo, base);
  const after = flatAtCommit(repo, headTip);
  const diff = diffFlat(before, after);
  const files: PullFile[] = [];
  for (const [path, oid] of [...diff.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const beforeBytes = blobBytes(repo, before, path);
    const afterBytes = oid === null ? null : blobBytes(repo, after, path);
    const { additions, deletions } = lineDiff(
      beforeBytes === null ? '' : beforeBytes.toString('utf8'),
      afterBytes === null ? '' : afterBytes.toString('utf8'),
    );
    files.push({
      filename: path,
      status: oid === null ? 'removed' : beforeBytes === null ? 'added' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/**
 * Try the three-way tree merge of a pull request into its base branch.
 * Returns the merged tree's flattened map, or null on a content conflict.
 */
export function mergedFlat(repo: RepoRec, pull: PullRec): Map<string, string> | null {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo.objects, baseTip, headTip);
  const atBase = base === null ? new Map<string, string>() : flatAtCommit(repo, base);
  const atHead = flatAtCommit(repo, headTip);
  const atCurrentBase = flatAtCommit(repo, baseTip);
  const headChanges = diffFlat(atBase, atHead);
  const baseChanges = diffFlat(atBase, atCurrentBase);
  const merged = new Map(atCurrentBase);
  for (const [path, oid] of headChanges) {
    if (baseChanges.has(path)) {
      const baseOid = baseChanges.get(path) ?? null;
      if (baseOid !== oid && atCurrentBase.get(path) !== atHead.get(path)) return null; // both sides changed it, differently
    }
    if (oid === null) merged.delete(path);
    else merged.set(path, oid);
  }
  return merged;
}

/** Whether a pull request can be merged cleanly right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  return mergedFlat(repo, pull) !== null;
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-open' | 'missing' };

/** Squash-merge a pull request into its base branch: one new commit carrying the head's changes. */
export function mergePull(store: Store, repo: RepoRec, pull: PullRec): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'not-open' };
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  if (baseTip === undefined) return { ok: false, reason: 'missing' };
  const flat = mergedFlat(repo, pull);
  if (flat === null) return { ok: false, reason: 'conflict' };
  const tree = buildTreeFromFlat(repo.objects, flat);
  const ident = forgeIdent(store.epochSec());
  const data = buildCommit({
    tree,
    parents: [baseTip],
    author: ident,
    committer: ident,
    message: pull.title,
  });
  const sha = putObject(repo.objects, 'commit', data);
  repo.refs.set(baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedSeq = store.tick();
  return { ok: true, sha };
}

/** Create a pull request record; the caller has validated the branches. */
export function createPull(
  store: Store,
  repo: RepoRec,
  input: { title: string; body: string; head: string; base: string },
): PullRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    number,
    seq: store.nextPullSeq(),
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    headRef: input.head,
    baseRef: input.base,
    headSha: branchTip(repo, input.head) ?? '',
    baseSha: branchTip(repo, input.base) ?? '',
    mergeCommitSha: null,
    createdSeq: store.tick(),
    mergedSeq: null,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** The commit message of a commit object, for the REST commits list. */
export function commitMessageOf(repo: RepoRec, sha: string): string {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).message;
}
