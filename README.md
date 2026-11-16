# github-core-clone-01 — a GitHub-compatible git forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/MuhammadRizki133/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/MuhammadRizki133/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A from-scratch, dependency-free implementation of GitHub's core forge surface, built for
[the github-core-clone-01 contest on make.fun](https://make.fun/bounty/github-core-clone-01).
One Node 22 process, standard library only, no `git` binary at runtime: the git object model
(loose-object hashing, trees, commits, annotated tags, packfiles with OFS/REF deltas, thin
packs, shallow clones) is implemented in TypeScript alongside the HTTP surfaces.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: bind an ephemeral port, `POST {"port": N}` to
`$MAKEFUN_ENV_URL/register`, then poll `$MAKEFUN_ENV_URL/done` and exit 0 when the trial ends.
There is nothing to install and no network access is needed or used.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` boot probe (no auth) |
| `GET /api/v3/` | API root with `X-Oauth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: meta, user, repositories (CRUD + pagination), branches, git refs, commits, contents (create/update/delete with sha guards), labels, issues + comments, pull requests (files, squash merge) |
| `POST /api/graphql` | GraphQL v4: viewer/repository/node reads, `__type` introspection probes, issue & pull-request connections with cursor pagination, operation batching, and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations |
| `POST /mcp` | MCP over streamable HTTP: `server/discover` + legacy `initialize`, `tools/list`, `tools/call` with create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |
| `/<owner>/<repo>.git/...` | git smart HTTP: protocol v0 and v2 `info/refs`, `git-upload-pack` (ls-refs, fetch with shallow/deepen), `git-receive-pack` (report-status, side-band-64k, delete-refs, per-ref non-fast-forward rejection) |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is
refused with 401. State is held in memory with a logical clock, so responses are deterministic:
the same request sequence always produces the same bytes.

## Layout

- `main.ts` — the entry ↔ env lifecycle (kept from the starter, unchanged).
- `app.ts` — HTTP router and auth.
- `store.ts` — the in-memory store: repositories, issues, pull requests, global node ids, logical clock.
- `gitobj.ts` — the git object model: SHA-1 object hashing, trees/commits/tags, packfile read/write with delta resolution, pkt-line codec.
- `domain.ts` — forge operations shared by every surface: commits on branches, issues, pull-request diffs, three-way merges, squash merges.
- `rest.ts` — the REST v3 resources.
- `githttp.ts` — the git smart-HTTP protocol (v0 + v2).
- `graphql.ts` — the GraphQL parser, schema and executor.
- `mcp.ts` — the MCP JSON-RPC endpoint and its tools.

## License

MIT — see `LICENSE`.
