// The MCP surface (POST /mcp): streamable-HTTP JSON-RPC with the modern server/discover
// handshake (and a legacy initialize fallback). Six tools mirror the forge's core operations.
// Tool schemas use the canonical argument names (owner, repo, title, body, head, base,
// pull_number, name, description, private, state) so schema-driven argument mapping in
// clients resolves directly. tools/list is a module-level constant: byte-identical across
// calls, as the protocol requires.

import { VIEWER } from './store.ts';
import type { RepoRec, Store } from './store.ts';
import { branchTip, createIssue, createPull, mergePull } from './domain.ts';
import { authed } from './web.ts';
import type { ReqCtx, Reply } from './web.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name in owner/repo form.' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter by state: open or closed.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['pull_number'],
    },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Reply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return { status, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function repoPayload(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
  };
}

function resolveRepo(store: Store, args: Record<string, unknown>): RepoRec | undefined {
  let owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : VIEWER.login;
  let name = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [fullOwner, fullName] = args.full_name.split('/', 2);
    if (name === '') name = fullName ?? '';
    if (typeof args.owner !== 'string') owner = fullOwner ?? owner;
  }
  if (name === '') return undefined;
  return store.repo(owner, name);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return toolError('name is required');
      if (store.repo(VIEWER.login, repoName) !== undefined) return toolError(`repository '${repoName}' already exists`);
      const repo = store.createRepo({
        owner: VIEWER.login,
        name: repoName,
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolResult(repoPayload(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      return toolResult(repoPayload(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolError('title is required');
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map((label) => String(label)).filter((label) => repo.labels.has(label)) : [];
      const issue = createIssue(store, repo, { title, body: typeof args.body === 'string' ? args.body : '', labels });
      return toolResult({
        id: issue.seq,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .map((issue) => ({ id: issue.seq, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head.replace(/^[^:]+:/, '') : '';
      const base = typeof args.base === 'string' ? args.base.replace(/^[^:]+:/, '') : '';
      if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null) return toolError(`head branch '${head}' does not exist`);
      if (baseSha === null) return toolError(`base branch '${base}' does not exist`);
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return toolError('a pull request already exists for this head and base');
      const pull = createPull(store, repo, { title, body: typeof args.body === 'string' ? args.body : '', head, base });
      return toolResult({
        id: pull.seq,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        merged: false,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === undefined) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      const pull = Number.isNaN(number) ? undefined : repo.pulls.get(number);
      if (pull === undefined) return toolError('pull request not found');
      const outcome = mergePull(store, repo, pull);
      if (!outcome.ok) return toolError(outcome.reason === 'conflict' ? 'the pull request has conflicts' : 'the pull request is not mergeable');
      return toolResult({
        id: pull.seq,
        number: pull.number,
        title: pull.title,
        state: 'closed',
        merged: true,
        sha: outcome.sha,
        html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function dispatch(store: Store, request: JsonRpcRequest): Reply | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  if (method.startsWith('notifications/')) return null;
  const params = (request.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(id, callTool(store, toolName, args));
      } catch (err) {
        return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp request. Auth is checked before any method handling. */
export function handleMCP(ctx: ReqCtx): Reply {
  if (!authed(ctx)) {
    return { status: 401, json: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } } };
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(body)) {
    const replies: unknown[] = [];
    for (const entry of body) {
      const reply = dispatch(ctx.store, (entry ?? {}) as JsonRpcRequest);
      if (reply !== null && reply.json !== undefined) replies.push(reply.json);
    }
    return { status: 200, json: replies };
  }
  const reply = dispatch(ctx.store, (body ?? {}) as JsonRpcRequest);
  if (reply === null) return { status: 202, raw: Buffer.alloc(0), contentType: 'application/json' };
  return reply;
}
