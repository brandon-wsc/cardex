# Testing policy

> **Status:** `pnpm test` — vitest + `@cloudflare/vitest-plugin`, running inside workerd against real D1 (migrations + `packages/mcp-worker/test/seed.sql`, a frozen fixture; `seed/seed.sql` is the prod snapshot and drifts with exports). `pnpm demo` remains the end-to-end check.
> **Principle:** gate on tool behavior. No repo-wide coverage percentage. No live issuer HTTP in CI.

Specs live next to `query.ts` and are sourced from the PRD tables — one row, one `it()`. Held contract deltas are `it.fails` (expected red; when the delta lands the flip forces you to unmark) or `it.todo` when the schema/function does not exist yet.

Add commands to the root [`AGENTS.md`](../AGENTS.md) when they actually run.

## Tiers

| Tier | What | Gate |
|------|------|------|
| **1 — Pure** | Filter, `limit`, and alias resolution over a checked-in fixture | **Fail** |
| **2 — Tools** | Each MCP tool returns a compact page and honors `limit`. `get_card` / `get_term` fetch by `id` | **Fail** |
| **Omit** | Wrangler deploy glue. Anything that fetches an issuer site | Not a PR check |

`score_candidates` tests, if the tool exists, assert that the result echoes `assumptions` and lists `unknown_exclusions`. They do not assert a winner.

Seed fixtures are committed. A test that needs the network to pass is a bug in the test.
