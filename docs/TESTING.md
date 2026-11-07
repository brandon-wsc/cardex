# Testing policy

> **Status:** `pnpm test` — vitest + `@cloudflare/vitest-plugin`, running inside workerd against real D1 (migrations + `packages/mcp-worker/test/seed.sql`, a frozen fixture; `seed/seed.sql` is the prod snapshot and drifts with exports). `pnpm demo` remains the end-to-end check.
> **Principle:** gate on tool behavior. No repo-wide coverage percentage. No live issuer HTTP in CI.

Specs live next to `query.ts` and are sourced from the PRD tables — one row, one `it()`. The map is mechanical: [`prd-rows.json`](prd-rows.json) keys every PRD §4–§6 table row (first cell, verbatim) to a spec-title substring, and `pnpm prd-rows` (CI job `prd-map`) fails on a row with no entry, an entry whose row is gone, or a substring no `it()` carries. Held contract deltas are `it.fails` (expected red; when the delta lands the flip forces you to unmark) or `it.todo` when the schema/function does not exist yet. `server.test.ts` covers the wire-level contract — it drives `buildServer` through a real `Client` + `InMemoryTransport` pair so input-schema behaviour (strict keys, InvalidParams) is tested where the SDK applies it.

Assert the envelope, not the machinery: error codes and structured fields, not `detail` phrasing; tool re-reads (`get_term`, `getProposal`, `listReports`), not raw `SELECT`; invariants like `records.length === total`, not fixture counts. If a behavior-preserving change turns a spec red, the spec was written too low — fix the spec, not the code.

Add commands to the root [`AGENTS.md`](../AGENTS.md) when they actually run.

## Tiers

| Tier | What | Gate |
|------|------|------|
| **1 — Pure** | Filter, `limit`, and alias resolution over a checked-in fixture | **Fail** |
| **2 — Tools** | Each MCP tool returns a compact page and honors `limit`. `get_card` / `get_term` fetch by `id` | **Fail** |
| **Omit** | Wrangler deploy glue. Anything that fetches an issuer site | Not a PR check |

`score_candidates` tests, if the tool exists, assert that the result echoes `assumptions` and lists `unknown_exclusions`. They do not assert a winner.

Seed fixtures are committed. A test that needs the network to pass is a bug in the test.

`pnpm data:check` is the facts-integrity gate for the prod snapshot, not a spec tier: `scripts/data-check.mjs` migrate+seeds the local D1, then runs semantic rules that cannot live in DDL — orphan FKs on every declared relation, `unit` matching rate `kind`, `rates.value > 0`, ordered `effective_from`/`effective_to` windows, and `exclusive_group` pairing with an integer `priority`. Violations fail with the offending row ids. The script self-tests first — every rule must trip on a planted violation in an in-memory copy (`--selftest-only` runs just that), so a silently broken check cannot go green. CI runs it on every PR with no path filter.
