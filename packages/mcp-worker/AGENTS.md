# mcp-worker

The v1 Worker: a remote MCP endpoint (`/mcp`, streamable HTTP via `createMcpHandler` from the agents SDK — not deprecated `McpAgent`) backed by D1. Query data lives in D1 — `seed/seed.sql` is a generated export snapshot of prod and loads it locally ([ADR 0002](../../docs/adr/0002-maintenance-surface.md)); rows carry their own `source_url` + `illustrative` flag, and `provenance` summarizes them per payload.

Runtime rules live in `wrangler.jsonc` and the Cloudflare Workers guidance. The compatibility date is the day the Worker was created (or the newest date the pinned workerd supports), and logs and traces are on (`observability.enabled`, `observability.traces.enabled`). `pnpm types` regenerates `worker-configuration.d.ts` after config changes.

The Worker stays on TypeScript 7 (the site uses TypeScript 6 — do not unify them).

Tool payloads live in `src/query.ts` — D1-backed shapes described by the PRD; do not invent a parallel shape written only in prose.
