// HTTP plumbing shared by every surface: the request context, the reply value handlers
// return, JSON body parsing, and pagination. app.ts turns a Reply into a real response
// (adding the request-id header and the JSON content type).

import type { Store } from './store.ts';

export interface ReqCtx {
  store: Store;
  /** The bearer token the env gave this process (MAKEFUN_SHOP_TOKEN). */
  token: string;
  method: string;
  /** The parsed request URL. */
  url: URL;
  /** The decoded pathname. */
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
  /** "http://host" of this very request, for absolute URLs in replies and Link headers. */
  origin: string;
}

export interface Reply {
  status: number;
  /** A JSON-serialisable body (sent as application/json). */
  json?: unknown;
  /** Raw bytes (git protocol replies); wins over `json`. */
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export function jsonReply(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return { status, json: body, headers };
}

export function messageReply(status: number, message: string): Reply {
  return { status, json: { message } };
}

/** Whether the request carries the trial's bearer token. */
export function authed(ctx: ReqCtx): boolean {
  const header = ctx.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === `Bearer ${ctx.token}`;
}

/** Parse the request body as JSON; null when it is not a JSON object/array or is malformed. */
export function jsonBody(ctx: ReqCtx): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** A string field of a JSON body, or undefined. */
export function strField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

/** Decode one path segment, tolerating malformed escapes. */
export function decodeSeg(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface Page<T> {
  items: T[];
  link: string | null;
}

/** Slice a list by ?page / ?per_page and build the GitHub-style Link header. */
export function paginate<T>(ctx: ReqCtx, all: readonly T[], pathWithQuery: string): Page<T> {
  const perPageRaw = Number.parseInt(ctx.url.searchParams.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.url.searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(ctx.url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `${ctx.origin}${pathWithQuery}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { items, link: links.length > 0 ? links.join(', ') : null };
}
