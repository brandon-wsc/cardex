# Cardex — Project status

> **Last updated:** 2026-10-31
> **Overall:** pre-alpha. `wrangler dev` serves the remote MCP over a seeded local D1.

This file is what exists in the tree today. Architecture and phases live in [ROADMAP](./ROADMAP.md).

## Summary

| Area | Status |
|------|--------|
| README | Run/dev, connect, non-goals |
| `AGENTS.md`, `CONTEXT.md`, PRD v0.3, roadmap, ADRs, test policy | In tree |
| Worker | `packages/mcp-worker` — remote MCP (`createMcpHandler`, streamable HTTP at `/mcp`) over D1, six tools at the P0 contract |
| D1 schema | `packages/mcp-worker/migrations/0001_init.sql` — cards, rates, terms, tags, join tables, aliases |
| Seed | `seed/seed.sql` — synthetic. Cited seed (popular-cards-first, real `source_url`s) is a P2 milestone |
| Contract deltas | **Held, not shipped.** `card_ids`, `as_of`, `limit` → 100, rate `unit`, `last_verified_at`, `seed_as_of`, `reports` + `report_issue`, expanded term kinds — specified in PRD §3–§6, not yet in `query.ts`/migrations |
| `skills/cardex` | Written — connect + tool guide. Playbook content is a P2 milestone ([ADR 0001](./adr/0001-product-shape.md)) |
| `skills/cardex-maintainer` | Not started — maintenance runbook for the seed loop ([ADR 0001](./adr/0001-product-shape.md)) |
| Maintenance loop | Not started — propose-via-PR → owner merge → apply to D1 |
| `docs/ai-workflow.md` | Stub |
| `LICENSE` | Named in the README as MIT. File not in the tree |
| Deploy | Local only. `wrangler.jsonc` has a placeholder `database_id`; no real D1 or workers.dev route yet |
| CI | Pull requests only. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) checks branch name, PR title, and commit subjects. vitest job is P1 |
| Tests | No runner yet — vitest is decided (P1). Policy is [TESTING.md](./TESTING.md). Check today is `pnpm demo` |

## Decisions

Recorded in [docs/adr/](./adr/) — [0001](./adr/0001-product-shape.md) locks the product shape: facts only, curated seed with human-approved maintenance, public read MCP, playbook as the surface. Do not restate it here unless the status of a decision changes (shipped, held, superseded).
