# ADR 0016 — Server-side usage counters via Workers Analytics Engine

- **Status:** Accepted
- **Date:** 2026-11-18
- **Updated:** 2026-11-21

## Context

The deployed Worker answers "is anyone using this" only indirectly. Workers
Observability (already enabled in `wrangler.jsonc`) shows request counts,
paths, and statuses, but it is sampled, short-retention, and cannot see
inside an MCP POST — a `tools/call` for `lookup_rates` looks identical to
one for `list_tags`. Seven days of traffic showed ~5,100 `/mcp` requests of
which ~93% was the owner's own dev and health checks; the only genuine
external hits were scanners (~20 requests). The question worth answering is
not "requests" but *discovery vs tool calls, which tools, which outcomes,
for which coarse client* — with the owner's traffic filtered out.

Two locked decisions bound the design. [ADR 0001](0001-product-shape.md):
no personal data — and several tools take caller-controlled free text
(`search_terms`/`resolve_alias` queries, `report_issue`/`propose_change`
fields) that could contain it. [ADR 0004](0004-public-site.md): no
tracking on the site — no client-side analytics, cookies, or third-party
scripts. This ADR adds **server-side** counters only; 0004 stands
unchanged, and no superseding is needed.

## Decision

1. **One Workers Analytics Engine dataset `cardex_usage`**, binding `USAGE`
   in `wrangler.jsonc`. AE columns are positional (`blob1..20`,
   `double1..20`, `index1`) — this section is the legend. Two row kinds are
   discriminated by `blob1`.

2. **`request` rows** — one per public `/mcp` request, written at the fetch
   edge after routing (including 401/404/429 short-circuits). Detailed
   `/maintainer`, `/admin`, and `asset_miss` events are not collected: the
   first two would amount to owner activity records, and the third is not an
   MCP adoption signal.

   | column | content |
   |---|---|
   | blob2 | surface: `mcp` |
   | blob3 | RPC method: `server/discover` / `initialize` / `tools/list` / `tools/call` / `ping` / `notification` / `batch` / `other` / `none` (any JSON array is `batch`, including a homogeneous one) |
   | blob4 | HTTP outcome: `ok` for status < 400, otherwise `error` / `rate_limited` / `unauthorized` / `not_found` |
   | blob5 | ua_bucket: `claude` / `cursor` / `chatgpt` / `grok` / `inspector` / `scanner` / `python` / `node` / `browser` / `other` / `-` |
   | blob6 | coarse geo: `hk` / `other` / `-`, mapped from `request.cf.country` |
   | blob7 | client bucket: legacy `params.clientInfo.name` on `initialize`, or modern per-request `params._meta["io.modelcontextprotocol/clientInfo"]`; `-` when absent |
   | blob8 | traffic_class: `self` / `external`, independent of the UA bucket |
   | blob9 | protocol: `2024-11-05` / `2025-03-26` / `2025-06-18` / `2025-11-25` / `2026-07-28` / `other` / `-` |
   | blob10 | rpc_error: fixed JSON-RPC/HTTP classes (`parse_error` / `invalid_request` / `invalid_params` / `method_not_found` / `method_not_allowed` / `not_acceptable` / `unsupported_media_type` / `payload_too_large` / `unsupported_protocol` / `missing_capability` / `header_mismatch` / `unauthorized` / `not_found` / `rate_limited` / `internal` / `rpc_error` / `-`) |
   | double1 | latency_ms (bounded body read plus time to response object, not stream drain) |
   | index1 | `req_id` — a random uuid per request, used only as AE's sampling key |

3. **`tool_call` rows** — one per validated tool-handler invocation, written
   by a `registerTool` interceptor (`trackServerTools`). Calls rejected
   before the handler (for example invalid params or an unknown tool) appear
   as request rows with `rpc_error=invalid_params`, not as tool invocations.

   | column | content |
   |---|---|
   | blob2 | surface: `mcp` |
   | blob3 | tool name (closed set) |
   | blob4 | outcome: `ok` / `error` (payload `isError`) / `thrown` |
   | blob5 | ua_bucket — same enum as above |
   | blob6 | coarse geo — same enum as above |
   | blob7 | `arg_keys`: sorted, globally allowlisted arg key NAMES joined `+`, `-` when none; unknown keys are omitted, never recorded |
   | blob8 | traffic_class — same enum as above |
   | blob9 | protocol — same enum as above |
   | blob10 | error class: `-`, a closed domain failure code, `tool_error`, or `thrown` |
   | blob11 | client bucket — the current request's client when the protocol supplies it, otherwise `-` |
   | double1 | handler latency_ms |
   | double2 | `result_count`: explicit per-tool primary-record count (`records` / `matches` / `candidates`, selected by `detail` for `search_terms`); successful singleton reads/writes count 1 and domain failures count 0 |
   | index1 | same per-request sampling key; no SQL join is implied |

4. **Never collected.** Free-text argument values, IPs, raw User-Agent or
   `clientInfo` strings, session ids, or direct person identifiers. Telemetry
   reads only `user-agent`, `x-cardex-probe`, `mcp-protocol-version`,
   `content-length`, and the response `content-type`; none is stored raw.
   `req_id` is telemetry-only, is never returned to the caller or reused in
   logs, and cannot link two requests by one caller. Analytics Engine does
   not support SQL `JOIN`, so request and tool rows must answer questions
   independently. There is deliberately no unique-caller counting, cohort
   conversion, or cross-request tool-sequence tracking.

5. **Self-traffic is a separate dimension.** Any request carrying
   `x-cardex-probe` has `traffic_class=self`; its UA is still bucketed
   normally. The owner's health checks and demo scripts send it so external
   traffic filters in one `WHERE` clause rather than by guessing UAs. The
   header is caller-controlled: `external` means "not self-tagged", not an
   authenticated person, and a caller can self-tag to exclude itself.

6. **Client identity follows the negotiated protocol.** Modern 2026-07-28
   requests can carry `clientInfo` in `_meta` on every request, including
   `server/discover` and `tools/call`. Legacy 2025-era clients normally
   supply it only on `initialize`; without a session, later requests stay
   `-` rather than being linked heuristically. `server/discover` and legacy
   `initialize` are discovery counters, not connects or unique callers.

7. **Absent binding is a no-op.** `env.USAGE` missing (tests, partial
   envs) disables writes, matching the AI/Vectorize fail-closed posture.
   Site traffic never reaches the Worker (assets-first), so page views
   stay in zone analytics — this dataset covers public MCP traffic only.

8. **Bounded parsing and error classification.** Request-body telemetry
   uses the MCP SDK's bounded reader with its 4 MiB limit and passes a
   successfully parsed body back to the handler, avoiding an unbounded
   clone parse and ensuring request metadata is present before tool rows
   are written. JSON responses and the first bounded (64 KiB) SSE event are
   inspected only for a numeric JSON-RPC error code or the SDK's fixed input-
   validation marker; messages and data are never recorded. SSE inspection
   runs via `waitUntil` without draining a long-lived stream. HTTP status and
   JSON-RPC outcome remain separate dimensions.

9. **Query path.** AE's SQL API — including via Cloudflare's hosted API
   MCP connector (`mcp.cloudflare.com/mcp`) with an owner-scoped
   read-only grant. Retention is ~3 months; volume (~5k writes/week) is
   far under the free tier. Counts and sums account for AE sampling, and
   the new `traffic_class` predicate excludes old rows that predate blob8:

   ```sql
   SELECT blob3 AS tool,
     SUM(_sample_interval) AS calls,
     SUM(_sample_interval * double2) AS results
   FROM cardex_usage
   WHERE blob1 = 'tool_call' AND blob8 = 'external'
     AND timestamp > NOW() - INTERVAL '7' DAY
   GROUP BY tool ORDER BY calls DESC
   ```

## Consequences

- `wrangler.jsonc` gains the `analytics_engine_datasets` binding — the
  wrangler-config owner-review gate applies. `pnpm types` regenerates
  `Env.USAGE`.
- All recorded blobs are closed enums or buckets, including geo and
  `arg_keys`. Adding a field or allowlisted arg key means extending this
  legend — schema changes belong in a new ADR or an explicit edit of this
  one. New columns are appended so old positional meanings remain stable.
- `usage.test.ts` carries the privacy gate: canary free-text values and
  caller-controlled arg/client names must never appear in any written blob.
  Modern discovery/client metadata, invalid params, privileged surfaces,
  self-traffic, homogeneous batches, and per-tool result counts are
  behavior gates too.
- Sink confinement is a hard gate: `cardex/telemetry-sink` (eslint) errors
  on `writeDataPoint` outside `usage.ts` and on `env.USAGE` outside
  `usage.ts`/`index.ts`, so no code path can write rows while bypassing
  the allowlists.
- Local `wrangler dev` uses a local Analytics Engine simulation by default;
  a remote binding or deployed script writes to the real dataset. All owner
  scripts and health checks should send `x-cardex-probe: 1` regardless.
  Tests inject a fake sink and never touch the real binding.
- ~1.5 rows per MCP POST at current volume — trivially under limits. AE may
  still sample at high volume, so queries use `_sample_interval`; the random
  per-request index prevents a single hot caller from dominating one key.
- Alerting rides on this dataset rather than adding new telemetry. The
  intended alert path: Cloudflare Monitors (Alerts → Monitors) run threshold
  queries on `cardex_usage` — `tool_call` rows with `blob4 = 'thrown'` and
  request rows with `blob4 = 'error'`, both scoped to `blob8 = 'external'` —
  plus Workers Issues (`observability.issues`, beta) for uncaught exceptions,
  failed invocations, and `console.error` failures like the scheduled
  reconcile. Monitor definitions, automations, and destinations are
  dashboard config, deliberately not in the tree.
