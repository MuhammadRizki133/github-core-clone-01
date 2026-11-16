// The GraphQL v4 surface (POST /api/graphql): a hand-written parser and executor for the
// document shapes gh and github-mcp-server send — viewer/repository reads, __type feature
// probes, issue and pull-request connections with cursor pagination, node(id:), the five
// mutations, and operation batching. Unknown fields answer HTTP 200 with an `errors` array
// naming the field, as GitHub does.

import { VIEWER, commentGlobalId, issueGlobalId, parseGlobalId, pullGlobalId, repoGlobalId, userGlobalId } from './store.ts';
import type { IssueRec, PullRec, RepoRec, Store } from './store.ts';
import { branchTip, createIssue, createPull, mergePull, pullFiles, pullMergeable } from './domain.ts';
import { jsonBody } from './web.ts';
import type { ReqCtx, Reply } from './web.ts';

// ---------------------------------------------------------------------------------------------
// Lexer and parser for the GraphQL subset the clients send.

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selection: SelNode[] | null;
}

type SelNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string; selection: SelNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelNode[];
}

interface Fragment {
  typeCondition: string;
  selection: SelNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:@$=!|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = source.slice(i + 3, end === -1 ? source.length : end);
        tokens.push(`"${text}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          text += source[j + 1] === 'n' ? '\n' : source[j + 1] === 't' ? '\t' : source[j + 1]!;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push(`"${text}"`);
      i = j + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name !== null) {
      tokens.push(name[0]);
      i += name[0].length;
      continue;
    }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (number !== null) {
      tokens.push(number[0]);
      i += number[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in document`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.parseVariableDefs();
        if (this.peek() === '@') this.skipDirectives();
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        if (this.peek() === '@') this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        let depth = 0;
        do {
          const token = this.next();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
        } while (depth > 0);
      }
    }
  }

  private parseVariableDefs(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelNode[] {
    this.expect('{');
    const selections: SelNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = new Map<string, Value>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.next();
      }
      if (this.peek() === '@') this.skipDirectives();
      let selection: SelNode[] | null = null;
      if (this.peek() === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    this.next();
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'number':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema: type field lists (what introspection reports) and enum values.

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'search', 'user', 'organization'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'isFork', 'parent'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'additions', 'deletions', 'changedFiles'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'isViewer'],
  Ref: ['name', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Node: ['id'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'possibleTypes', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  StatusState: ['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS'],
};

function typeKind(name: string): string {
  if (ENUM_VALUES[name] !== undefined) return 'ENUM';
  if (name === 'Node') return 'INTERFACE';
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID' || name === 'Float') return 'SCALAR';
  if (name.endsWith('Input')) return 'INPUT_OBJECT';
  return 'OBJECT';
}

function typeObject(name: string): Record<string, unknown> | null {
  if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined && typeKind(name) !== 'SCALAR') return null;
  return { __typename: '__Type', name };
}

// ---------------------------------------------------------------------------------------------
// Object factories: the values resolvers walk.

interface GqlRepo {
  __typename: 'Repository';
  repo: RepoRec;
}

interface GqlIssue {
  __typename: 'Issue';
  repo: RepoRec;
  issue: IssueRec;
}

interface GqlPull {
  __typename: 'PullRequest';
  repo: RepoRec;
  pull: PullRec;
}

const USER_OBJECT = { __typename: 'User' } as const;

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Connection<T> {
  __typename: string;
  nodes: T[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

function pageOf<T extends { number: number }>(all: readonly T[], first: number | undefined, after: string | undefined): { slice: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (after !== undefined && after !== null) {
    const afterNumber = numberOfCursor(after);
    const index = afterNumber === null ? -1 : all.findIndex((item) => item.number === afterNumber);
    start = index === -1 ? 0 : index + 1;
  }
  const limit = first === undefined ? all.length : Math.max(0, first);
  const slice = all.slice(start, start + limit);
  return {
    slice,
    hasNextPage: start + slice.length < all.length,
    endCursor: slice.length === 0 ? null : cursorOf(slice[slice.length - 1]!.number),
  };
}

// ---------------------------------------------------------------------------------------------
// Resolvers

type Obj = Record<string, unknown>;
type Resolver = (store: Store, obj: Obj, args: Record<string, unknown>) => unknown;

class GqlProblem extends Error {}

function repoFromGlobalId(store: Store, id: string): RepoRec | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  const dbId = Number(parsed.payload);
  return store.allRepos().find((repo) => repo.dbId === dbId) ?? null;
}

function issueFromGlobalId(store: Store, id: string): { repo: RepoRec; issue: IssueRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const [dbIdRaw, numberRaw] = parsed.payload.split(':');
  const repo = store.allRepos().find((candidate) => candidate.dbId === Number(dbIdRaw));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(numberRaw));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(store: Store, id: string): { repo: RepoRec; pull: PullRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const [dbIdRaw, numberRaw] = parsed.payload.split(':');
  const repo = store.allRepos().find((candidate) => candidate.dbId === Number(dbIdRaw));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(numberRaw));
  return pull === undefined ? null : { repo, pull };
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => USER_OBJECT,
    repository: (store, _obj, args) => {
      const repo = store.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : ({ __typename: 'Repository', repo } satisfies GqlRepo);
    },
    node: (store, _obj, args) => {
      const id = String(args.id ?? '');
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = repoFromGlobalId(store, id);
        return repo === null ? null : ({ __typename: 'Repository', repo } satisfies GqlRepo);
      }
      if (parsed.type === 'Issue') {
        const found = issueFromGlobalId(store, id);
        return found === null ? null : ({ __typename: 'Issue', repo: found.repo, issue: found.issue } satisfies GqlIssue);
      }
      if (parsed.type === 'PullRequest') {
        const found = pullFromGlobalId(store, id);
        return found === null ? null : ({ __typename: 'PullRequest', repo: found.repo, pull: found.pull } satisfies GqlPull);
      }
      if (parsed.type === 'User') return USER_OBJECT;
      return null;
    },
    nodes: () => null,
    rateLimit: () => null,
    search: () => null,
    user: (_store, _obj, args) => (args.login === VIEWER.login ? USER_OBJECT : null),
    organization: () => null,
    __type: (_store, _obj, args) => typeObject(String(args.name ?? '')),
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (store, _obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(store, String(input.repositoryId ?? ''));
      if (repo === null) throw new GqlProblem('repositoryId does not name a repository');
      const issue = createIssue(store, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } satisfies GqlIssue, clientMutationId: null };
    },
    closeIssue: (store, _obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(store, String(input.issueId ?? ''));
      if (found === null) throw new GqlProblem('issueId does not name an issue');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } satisfies GqlIssue, clientMutationId: null };
    },
    createPullRequest: (store, _obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(store, String(input.repositoryId ?? ''));
      if (repo === null) throw new GqlProblem('repositoryId does not name a repository');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (branchTip(repo, head) === null) throw new GqlProblem(`head ref '${head}' does not exist`);
      if (branchTip(repo, base) === null) throw new GqlProblem(`base ref '${base}' does not exist`);
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) throw new GqlProblem('a pull request already exists for this head and base');
      const pull = createPull(store, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head,
        base,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } satisfies GqlPull, clientMutationId: null };
    },
    mergePullRequest: (store, _obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullFromGlobalId(store, String(input.pullRequestId ?? ''));
      if (found === null) throw new GqlProblem('pullRequestId does not name a pull request');
      const outcome = mergePull(store, found.repo, found.pull);
      if (!outcome.ok) throw new GqlProblem(outcome.reason === 'conflict' ? 'the pull request has conflicts' : 'the pull request is not mergeable');
      return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } satisfies GqlPull, clientMutationId: null };
    },
    addComment: (store, _obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(store, String(input.subjectId ?? ''));
      if (found === null) throw new GqlProblem('subjectId does not name an issue');
      const comment = { seq: store.nextCommentSeq(), body: String(input.body ?? ''), createdSeq: store.tick() };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment },
          cursor: cursorOf(found.issue.number),
        },
        clientMutationId: null,
      };
    },
    updateIssue: () => {
      throw new GqlProblem('updateIssue is not supported');
    },
    createRepository: () => {
      throw new GqlProblem('createRepository is not supported');
    },
  },
  Repository: {
    id: (_s, obj) => repoGlobalId((obj as unknown as GqlRepo).repo),
    databaseId: (_s, obj) => (obj as unknown as GqlRepo).repo.dbId,
    name: (_s, obj) => (obj as unknown as GqlRepo).repo.name,
    nameWithOwner: (_s, obj) => {
      const repo = (obj as unknown as GqlRepo).repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: () => USER_OBJECT,
    description: (_s, obj) => (obj as unknown as GqlRepo).repo.description,
    isPrivate: (_s, obj) => (obj as unknown as GqlRepo).repo.isPrivate,
    isFork: () => false,
    parent: () => null,
    url: (_s, obj) => {
      const repo = (obj as unknown as GqlRepo).repo;
      return `https://forge.local/${repo.owner}/${repo.name}`;
    },
    createdAt: (store, obj) => store.isoAt((obj as unknown as GqlRepo).repo.createdSeq),
    updatedAt: (store, obj) => store.isoAt((obj as unknown as GqlRepo).repo.createdSeq),
    defaultBranchRef: (_s, obj) => {
      const repo = (obj as unknown as GqlRepo).repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (_s, obj, args) => {
      const repo = (obj as unknown as GqlRepo).repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } satisfies GqlIssue);
    },
    issues: (store, obj, args) => {
      const repo = (obj as unknown as GqlRepo).repo;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
      issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
      void store;
      const page = pageOf(issues, typeof args.first === 'number' ? args.first : undefined, typeof args.after === 'string' ? args.after : undefined);
      const connection: Connection<GqlIssue> = {
        __typename: 'IssueConnection',
        nodes: page.slice.map((issue) => ({ __typename: 'Issue', repo, issue })),
        totalCount: issues.length,
        hasNextPage: page.hasNextPage,
        endCursor: page.endCursor,
      };
      return connection;
    },
    pullRequest: (_s, obj, args) => {
      const repo = (obj as unknown as GqlRepo).repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } satisfies GqlPull);
    },
    pullRequests: (_s, obj, args) => {
      const repo = (obj as unknown as GqlRepo).repo;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return states.includes(state);
        });
      }
      pulls.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const page = pageOf(pulls, typeof args.first === 'number' ? args.first : undefined, typeof args.after === 'string' ? args.after : undefined);
      const connection: Connection<GqlPull> = {
        __typename: 'PullRequestConnection',
        nodes: page.slice.map((pull) => ({ __typename: 'PullRequest', repo, pull })),
        totalCount: pulls.length,
        hasNextPage: page.hasNextPage,
        endCursor: page.endCursor,
      };
      return connection;
    },
  },
  Issue: {
    id: (_s, obj) => {
      const { repo, issue } = obj as unknown as GqlIssue;
      return issueGlobalId(repo, issue);
    },
    databaseId: (_s, obj) => (obj as unknown as GqlIssue).issue.seq,
    number: (_s, obj) => (obj as unknown as GqlIssue).issue.number,
    title: (_s, obj) => (obj as unknown as GqlIssue).issue.title,
    body: (_s, obj) => (obj as unknown as GqlIssue).issue.body,
    state: (_s, obj) => (obj as unknown as GqlIssue).issue.state.toUpperCase(),
    author: () => USER_OBJECT,
    createdAt: (store, obj) => store.isoAt((obj as unknown as GqlIssue).issue.createdSeq),
    updatedAt: (store, obj) => store.isoAt((obj as unknown as GqlIssue).issue.createdSeq),
    url: (_s, obj) => {
      const { repo, issue } = obj as unknown as GqlIssue;
      return `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    labels: () => ({ __typename: 'LabelConnection', nodes: [] }),
    comments: () => ({ __typename: 'IssueCommentConnection', nodes: [] }),
    repository: (_s, obj) => ({ __typename: 'Repository', repo: (obj as unknown as GqlIssue).repo }),
  },
  PullRequest: {
    id: (_s, obj) => {
      const { repo, pull } = obj as unknown as GqlPull;
      return pullGlobalId(repo, pull);
    },
    databaseId: (_s, obj) => (obj as unknown as GqlPull).pull.seq,
    number: (_s, obj) => (obj as unknown as GqlPull).pull.number,
    title: (_s, obj) => (obj as unknown as GqlPull).pull.title,
    body: (_s, obj) => (obj as unknown as GqlPull).pull.body,
    state: (_s, obj) => {
      const pull = (obj as unknown as GqlPull).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_s, obj) => (obj as unknown as GqlPull).pull.merged,
    headRefName: (_s, obj) => (obj as unknown as GqlPull).pull.headRef,
    baseRefName: (_s, obj) => (obj as unknown as GqlPull).pull.baseRef,
    mergeable: (_s, obj) => {
      const { repo, pull } = obj as unknown as GqlPull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (_s, obj, args) => {
      const { repo, pull } = obj as unknown as GqlPull;
      const all = pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : all.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: all.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', file })),
        totalCount: all.length,
      };
    },
    author: () => USER_OBJECT,
    createdAt: (store, obj) => store.isoAt((obj as unknown as GqlPull).pull.createdSeq),
    updatedAt: (store, obj) => store.isoAt((obj as unknown as GqlPull).pull.mergedSeq ?? (obj as unknown as GqlPull).pull.createdSeq),
    url: (_s, obj) => {
      const { repo, pull } = obj as unknown as GqlPull;
      return `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    additions: (_s, obj) => {
      const { repo, pull } = obj as unknown as GqlPull;
      return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
    },
    deletions: (_s, obj) => {
      const { repo, pull } = obj as unknown as GqlPull;
      return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
    },
    changedFiles: (_s, obj) => {
      const { repo, pull } = obj as unknown as GqlPull;
      return pullFiles(repo, pull).length;
    },
  },
  PullRequestChangedFile: {
    path: (_s, obj) => (obj as { file: { filename: string } }).file.filename,
    additions: (_s, obj) => (obj as { file: { additions: number } }).file.additions,
    deletions: (_s, obj) => (obj as { file: { deletions: number } }).file.deletions,
    changeType: (_s, obj) => (obj as { file: { status: string } }).file.status.toUpperCase(),
  },
  User: {
    id: () => userGlobalId(),
    databaseId: () => VIEWER.id,
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    avatarUrl: () => '',
    url: () => `https://forge.local/${VIEWER.login}`,
    isViewer: () => true,
  },
  Ref: {
    name: (_s, obj) => (obj as { name: string }).name,
    prefix: () => 'refs/heads/',
  },
  IssueConnection: {
    nodes: (_s, obj) => (obj as unknown as Connection<GqlIssue>).nodes,
    edges: (_s, obj) => (obj as unknown as Connection<GqlIssue>).nodes.map((node) => ({ __typename: 'IssueEdge', node, cursor: cursorOf(node.issue.number) })),
    pageInfo: (_s, obj) => {
      const connection = obj as unknown as Connection<GqlIssue>;
      return { __typename: 'PageInfo', hasNextPage: connection.hasNextPage, hasPreviousPage: false, startCursor: connection.nodes[0] === undefined ? null : cursorOf(connection.nodes[0].issue.number), endCursor: connection.endCursor };
    },
    totalCount: (_s, obj) => (obj as unknown as Connection<GqlIssue>).totalCount,
  },
  PullRequestConnection: {
    nodes: (_s, obj) => (obj as unknown as Connection<GqlPull>).nodes,
    edges: (_s, obj) => (obj as unknown as Connection<GqlPull>).nodes.map((node) => ({ __typename: 'PullRequestEdge', node, cursor: cursorOf(node.pull.number) })),
    pageInfo: (_s, obj) => {
      const connection = obj as unknown as Connection<GqlPull>;
      return { __typename: 'PageInfo', hasNextPage: connection.hasNextPage, hasPreviousPage: false, startCursor: connection.nodes[0] === undefined ? null : cursorOf(connection.nodes[0].pull.number), endCursor: connection.endCursor };
    },
    totalCount: (_s, obj) => (obj as unknown as Connection<GqlPull>).totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (_s, obj) => (obj as { nodes: unknown[] }).nodes,
    totalCount: (_s, obj) => (obj as { totalCount: number }).totalCount,
  },
  PageInfo: {
    hasNextPage: (_s, obj) => (obj as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (_s, obj) => (obj as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (_s, obj) => (obj as { startCursor: string | null }).startCursor,
    endCursor: (_s, obj) => (obj as { endCursor: string | null }).endCursor,
  },
  CreateIssuePayload: {
    issue: (_s, obj) => (obj as { issue: unknown }).issue,
    clientMutationId: (_s, obj) => (obj as { clientMutationId: unknown }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (_s, obj) => (obj as { issue: unknown }).issue,
    clientMutationId: (_s, obj) => (obj as { clientMutationId: unknown }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (_s, obj) => (obj as { pullRequest: unknown }).pullRequest,
    clientMutationId: (_s, obj) => (obj as { clientMutationId: unknown }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (_s, obj) => (obj as { pullRequest: unknown }).pullRequest,
    clientMutationId: (_s, obj) => (obj as { clientMutationId: unknown }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (_s, obj) => (obj as { commentEdge: unknown }).commentEdge,
    clientMutationId: (_s, obj) => (obj as { clientMutationId: unknown }).clientMutationId,
  },
  IssueCommentEdge: {
    node: (_s, obj) => (obj as { node: unknown }).node,
    cursor: (_s, obj) => (obj as { cursor: string }).cursor,
  },
  IssueComment: {
    id: (_s, obj) => {
      const value = obj as { repo: RepoRec; issue: IssueRec; comment: { seq: number } };
      return commentGlobalId(value.repo, value.issue, value.comment as never);
    },
    body: (_s, obj) => (obj as { comment: { body: string } }).comment.body,
    author: () => USER_OBJECT,
    createdAt: (store, obj) => store.isoAt((obj as { comment: { createdSeq: number } }).comment.createdSeq),
    updatedAt: (store, obj) => store.isoAt((obj as { comment: { createdSeq: number } }).comment.createdSeq),
  },
  __Type: {
    name: (_s, obj) => (obj as { name: string }).name,
    kind: (_s, obj) => typeKind((obj as { name: string }).name),
    description: () => null,
    fields: (_s, obj) => {
      const name = (obj as { name: string }).name;
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      return fields.map((field) => ({ __typename: '__Field', name: field }));
    },
    enumValues: (_s, obj) => {
      const name = (obj as { name: string }).name;
      const values = ENUM_VALUES[name];
      if (values === undefined) return null;
      return values.map((value) => ({ __typename: '__EnumValue', name: value }));
    },
    inputFields: () => null,
    possibleTypes: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (_s, obj) => (obj as { name: string }).name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_s, obj) => (obj as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => Object.keys(TYPE_FIELDS).map((name) => typeObject(name)).filter((x) => x !== null),
    queryType: () => typeObject('Query'),
    mutationType: () => typeObject('Mutation'),
    subscriptionType: () => null,
    directives: () => [],
  },
};

// ---------------------------------------------------------------------------------------------
// Executor

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
  errors: { message: string; path: (string | number)[] }[];
}

function executeSelection(
  ctx: ExecCtx,
  obj: unknown,
  typeName: string,
  selection: SelNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const record = (typeof obj === 'object' && obj !== null ? obj : {}) as Obj;
  for (const node of selection) {
    if (node.kind === 'inline') {
      if (node.typeCondition === typeName || node.typeCondition === 'Node') {
        Object.assign(out, executeSelection(ctx, obj, typeName, node.selection, path));
      }
      continue;
    }
    if (node.kind === 'spread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelection(ctx, obj, typeName, fragment.selection, path));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[node.name] ?? (typeName === 'Query' && (node.name === '__type' || node.name === '__schema') ? RESOLVERS.Query[node.name] : undefined);
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of node.args) args[argName] = resolveValue(argValue, ctx.variables);
    let value: unknown;
    try {
      value = resolver(ctx.store, record, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, node.selection, [...path, key]);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, selection: SelNode[] | null, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(ctx, item, selection, [...path, index]));
  }
  if (typeof value === 'object') {
    const typename = (value as Obj).__typename;
    if (typeof typename === 'string' && selection !== null) {
      return executeSelection(ctx, value, typename, selection, path);
    }
    if (selection !== null) return {};
    return value;
  }
  return value;
}

/** Execute one operation document; returns the {data, errors?} envelope. */
export function executeGraphQL(store: Store, document: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  let parsed: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    parsed = new Parser(document).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName === undefined
    ? parsed.operations[0]
    : parsed.operations.find((candidate) => candidate.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { store, variables, fragments: parsed.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, { __typename: rootType }, rootType, operation.selection, []);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** Handle one POST /api/graphql request (auth already verified by app.ts). */
export function handleGraphQL(ctx: ReqCtx): Reply {
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, json: { message: 'Problems parsing JSON' } };
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const operation = (entry ?? {}) as Record<string, unknown>;
      return executeGraphQL(
        ctx.store,
        String(operation.query ?? ''),
        (operation.variables ?? {}) as Record<string, unknown>,
        typeof operation.operationName === 'string' ? operation.operationName : undefined,
      );
    });
    return { status: 200, json: results };
  }
  const parsed = jsonBody(ctx);
  if (!parsed.ok) return { status: 400, json: { message: 'Problems parsing JSON' } };
  const result = executeGraphQL(
    ctx.store,
    String(parsed.value.query ?? ''),
    (parsed.value.variables ?? {}) as Record<string, unknown>,
    typeof parsed.value.operationName === 'string' ? parsed.value.operationName : undefined,
  );
  return { status: 200, json: result };
}
