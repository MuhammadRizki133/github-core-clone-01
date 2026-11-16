// The forge's in-memory state: one account, its repositories, and inside each repository the
// git object store, refs, labels, issues and pull requests. Everything is deterministic: ids
// come from counters and timestamps from a logical clock (a fixed epoch plus a monotonic
// sequence), never from the wall clock, so a replayed trial sees byte-identical answers.

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The one account this forge serves: the owner of the trial's bearer token. */
export const VIEWER: Viewer = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

/** 2025-01-01T00:00:00Z: the base of the logical clock. */
const EPOCH_BASE_SEC = 1735689600;

export interface GitObjectRec {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  /** Forge-global comment sequence; also the REST comment id. */
  seq: number;
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  number: number;
  /** Forge-global issue sequence; the REST issue id. */
  seq: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  /** Forge-global pull sequence; the REST pull id. */
  seq: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** Branch tips when the pull request was opened. */
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  createdSeq: number;
  mergedSeq: number | null;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObjectRec>;
  /** Full ref names ("refs/heads/main") to object ids. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** One number sequence shared by issues and pull requests, as on GitHub. */
  nextNumber: number;
}

export class Store {
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private clock = 0;
  private requestSeq = 0;

  /** Advance the logical clock and return its new value (a sequence number). */
  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  /** The current logical time as epoch seconds. */
  epochSec(): number {
    return EPOCH_BASE_SEC + this.clock;
  }

  /** The current logical time as an ISO-8601 string. */
  isoNow(): string {
    return new Date(this.epochSec() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** An ISO-8601 string for a recorded sequence number. */
  isoAt(seq: number): string {
    return new Date((EPOCH_BASE_SEC + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** A unique, deterministic request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `F${this.requestSeq.toString(16).toUpperCase().padStart(7, '0')}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec {
    this.repoSeq += 1;
    const repo: RepoRec = {
      dbId: this.repoSeq,
      owner: VIEWER.login,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      createdSeq: this.tick(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  /** A repository by owner/name; another owner's namespace never resolves. */
  repo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
  }

  /** The viewer's repositories in creation order. */
  allRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.dbId - b.dbId);
  }

  nextIssueSeq(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextPullSeq(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }

  nextCommentSeq(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

// ---------------------------------------------------------------------------------------------
// Global (Relay-style) ids: opaque base64 payloads, stable across reads, never the plain number.

const TYPE_CODES: Readonly<Record<string, string>> = {
  Repository: '010',
  Issue: '05',
  PullRequest: '09',
  IssueComment: '06',
  User: '04',
};

const CODE_TYPES: Readonly<Record<string, string>> = {
  '010': 'Repository',
  '05': 'Issue',
  '09': 'PullRequest',
  '06': 'IssueComment',
  '04': 'User',
};

/** Encode a global id: base64 of "<code>:<Type><payload>". */
export function globalId(type: string, payload: string): string {
  const code = TYPE_CODES[type] ?? '099';
  return Buffer.from(`${code}:${type}${payload}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and payload, or null when it is not one of ours. */
export function parseGlobalId(id: string): { type: string; payload: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(\d+):([A-Za-z]+)(.*)$/.exec(text);
  if (match === null) return null;
  const type = CODE_TYPES[match[1] ?? ''];
  if (type === undefined || type !== match[2]) return null;
  return { type, payload: match[3] ?? '' };
}

export function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', String(repo.dbId));
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId('Issue', `${repo.dbId}:${issue.number}`);
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return globalId('PullRequest', `${repo.dbId}:${pull.number}`);
}

export function commentGlobalId(repo: RepoRec, issue: IssueRec, comment: CommentRec): string {
  return globalId('IssueComment', `${repo.dbId}:${issue.number}:${comment.seq}`);
}

export function userGlobalId(): string {
  return globalId('User', String(VIEWER.id));
}
