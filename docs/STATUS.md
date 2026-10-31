# Cardex — Project status

> **Last updated:** 2026-11-01
> **Overall:** pre-alpha. `wrangler dev` serves the remote MCP over a seeded local D1.

This file is what exists in the tree today. Architecture and phases live in [ROADMAP](./ROADMAP.md).

## Summary

| Area | Status |
|------|--------|
| README | Run/dev, connect, non-goals |
| `AGENTS.md`, `CONTEXT.md`, PRD v0.3, roadmap, ADRs, test policy | In tree |
| Worker | `packages/mcp-worker` — remote MCP (`createMcpHandler`, streamable HTTP at `/mcp`) over D1, seven tools at the v0.3 contract |
| D1 schema | `packages/mcp-worker/migrations/0001`–`0003` — cards, rates, terms (12 kinds), `term_merchants`, join tables, aliases, `reports` |
| Seed | `seed/seed.sql` — synthetic. Cited seed (popular-cards-first, real `source_url`s) is a P2 milestone |
| Contract deltas | Shipped — `card_ids`, `as_of`, `limit` 100, rate `unit`, `last_verified_at`, `seed_as_of`, `reports` + `report_issue`, audited term kinds |
| `skills/cardex` | Written — connect + tool guide + per-kind settle checklist at the v0.3 contract |
| `skills/cardex-maintainer` | Not started — maintenance runbook for the proposal loop ([ADR 0002](./adr/0002-maintenance-surface.md)) |
| Maintenance surface | Designed, not built — `/maintainer` + `proposals` + `/admin` portal per [ADR 0002](./adr/0002-maintenance-surface.md); until then the owner applies changes via `wrangler d1 execute` |
| `docs/ai-workflow.md` | Stub |
| `LICENSE` | Named in the README as MIT. File not in the tree |
| Deploy | Local only. `wrangler.jsonc` has a placeholder `database_id`; no real D1 or workers.dev route yet |
| CI | Pull requests only. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) checks branch name, PR title, commit subjects — and runs vitest + typecheck |
| Tests | vitest over `query.ts` in workerd + real D1 — 55 specs from the PRD tables. Policy is [TESTING.md](./TESTING.md) |

## Decisions

Recorded in [docs/adr/](./adr/) — [0001](./adr/0001-product-shape.md) locks the product shape: facts only, human-approved maintenance, public read MCP, playbook as the surface. [0002](./adr/0002-maintenance-surface.md) supersedes its write path: D1 is the truth, approvals happen in a portal over structured proposals, and the maintenance agent's only credential is a `/maintainer` token. Do not restate them here unless the status of a decision changes (shipped, held, superseded).
