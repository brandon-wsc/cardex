# Testing policy

> **Status:** no test runner yet — vitest is the decided runner (P1, alongside the PRD contract deltas). Today's check is `pnpm demo` from the repo root — it migrates and seeds local D1, boots `wrangler dev`, and runs scripted calls through a real MCP client.
> **Principle:** gate on tool behavior. No repo-wide coverage percentage. No live issuer HTTP in CI.

Add commands to the root [`AGENTS.md`](../AGENTS.md) when they actually run.

## When the runner lands

| Tier | What | Gate |
|------|------|------|
| **1 — Pure** | Filter, `limit`, and alias resolution over a checked-in fixture | **Fail** |
| **2 — Tools** | Each MCP tool returns a compact page and honors `limit`. `get_card` / `get_term` fetch by `id` | **Fail** |
| **Omit** | Wrangler deploy glue. Anything that fetches an issuer site | Not a PR check |

`score_candidates` tests, if the tool exists, assert that the result echoes `assumptions` and lists `unknown_exclusions`. They do not assert a winner.

Seed fixtures are committed. A test that needs the network to pass is a bug in the test.
