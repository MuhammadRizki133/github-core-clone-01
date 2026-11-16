// The forge's HTTP router: /healthz for the boot check, REST v3 under /api/v3, GraphQL v4 at
// /api/graphql, MCP at /mcp, and git smart HTTP under /<owner>/<repo>.git. Everything except
// /healthz requires the bearer token; every reply carries an X-GitHub-Request-Id; unknown
// paths answer GitHub's JSON 404. All state lives in one in-memory Store per process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store } from './store.ts';
import { authed, jsonReply, messageReply } from './web.ts';
import type { Reply, ReqCtx } from './web.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { handleGitHttp } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function writeReply(store: Store, res: ServerResponse, reply: Reply, withRequestId: boolean): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  if (withRequestId) headers['x-github-request-id'] = store.nextRequestId();
  if (reply.raw !== undefined) {
    res.writeHead(reply.status, {
      'content-type': reply.contentType ?? 'application/octet-stream',
      'content-length': reply.raw.length,
      ...headers,
    });
    res.end(reply.raw);
    return;
  }
  const text = `${JSON.stringify(reply.json ?? null)}\n`;
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        url = new URL('/', 'http://entry');
      }
      const method = req.method ?? 'GET';
      let path = url.pathname;
      if (path === '/api/v3') path = '/api/v3/';
      const host = req.headers.host ?? 'entry';
      const ctx: ReqCtx = {
        store,
        token,
        method,
        url,
        path,
        headers: req.headers,
        body: Buffer.alloc(0),
        origin: `http://${host}`,
      };

      // The env's boot check: no auth, exact body.
      if (method === 'GET' && path === '/healthz') {
        writeReply(store, res, jsonReply(200, { ok: true }), false);
        return;
      }

      try {
        ctx.body = await readBody(req);
      } catch {
        writeReply(store, res, messageReply(400, 'Request body too large'), true);
        return;
      }

      let reply: Reply;
      try {
        if (path === '/mcp') {
          reply = handleMCP(ctx);
        } else if (!authed(ctx)) {
          reply = messageReply(401, 'Bad credentials');
        } else if (path.startsWith('/api/v3/')) {
          reply = handleRest(ctx);
        } else if (path === '/api/graphql') {
          reply = method === 'POST' ? handleGraphQL(ctx) : messageReply(404, 'Not Found');
        } else {
          const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
          if (gitMatch !== null) {
            const owner = decodeURIComponent(gitMatch[1]!);
            const name = decodeURIComponent(gitMatch[2]!);
            const tail = gitMatch[3] ?? '';
            const repo = store.repo(owner, name);
            if (repo === undefined) {
              reply = messageReply(404, 'Not Found');
            } else if (tail === '/info/refs') {
              const service = url.searchParams.get('service') ?? '';
              reply = service === 'git-upload-pack' || service === 'git-receive-pack'
                ? handleGitHttp(ctx, repo, service, 'info/refs')
                : messageReply(400, 'invalid service');
            } else if (tail === '/git-upload-pack' || tail === '/git-receive-pack') {
              reply = handleGitHttp(ctx, repo, tail.slice(1), tail.slice(1));
            } else {
              reply = messageReply(404, 'Not Found');
            }
          } else {
            reply = messageReply(404, 'Not Found');
          }
        }
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        reply = messageReply(500, 'Internal Server Error');
      }
      writeReply(store, res, reply, true);
    })().catch((err: unknown) => {
      process.stderr.write(`[entry] request error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': JSON_TYPE });
      res.end();
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  return server;
}
