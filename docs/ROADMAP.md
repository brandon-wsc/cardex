# Cardex — Roadmap

> **Stack:** Cloudflare Workers · TypeScript · D1 (SQLite) · remote MCP
> **Status:** pre-alpha. The Worker serves locally via `wrangler dev` over a synthetic-seeded D1.

Language for the nouns below is [`CONTEXT.md`](../CONTEXT.md). Locked trade-offs are [`docs/adr/`](adr/).

## Vision

Any personal agent can answer "which card" well. Cardex is the pair that makes that possible: a **playbook** (shipped as `skills/cardex`) that teaches the reasoning — registration windows, foreign-currency fees, caps, exclusions — and a **facts backend** (remote MCP over D1) that returns compact, structured records. The caller does its own ranking; Cardex never sees a wallet.

## Architecture principles

| Principle | Decision |
|-----------|----------|
| Facts only | Records in, judgment stays with the caller ([ADR 0001](adr/0001-product-shape.md)) |
| Playbook surface | The skill is the product; the Worker is its backend ([ADR 0001](adr/0001-product-shape.md)) |
| Curated facts | Facts live in D1; `seed.sql` is a generated dev snapshot. Structured lookup ([ADR 0002](adr/0002-maintenance-surface.md)) |
| Human-approved maintenance | Agent proposes via `/maintainer` into `proposals`; the owner's portal approve is the only write path ([ADR 0002](adr/0002-maintenance-surface.md)) |
| Public read | Remote MCP on Workers, no auth on reads; auth lives on `/maintainer` and `/admin` ([ADR 0002](adr/0002-maintenance-surface.md)) |
| Compact tools | Filters + `limit`. Follow-up reads are by `id` |

## Data relations (v1)

```
issuer ──< card ──< rate ──< term
                └──< rate_tag >── tag ──< alias_tag ── alias
card ──< alias_card ── alias
rate ──< rate_term >── term

issuer/network aliases live in code (src/aliases.ts), not D1 — near-closed sets

reports   (quarantine — written by report_issue, read only by the maintenance loop)
```

- A card has many rates. A rate has many terms (`rate_terms`) and many tags (`rate_tags`).
- Tags and rates are many-to-many. Tags overlap.
- An alias maps a free-text name onto one or more tags or cards (`alias_tags`, `alias_cards`).
- `reports` is deliberately outside the query relations — it is triage input, never facts ([ADR 0001](adr/0001-product-shape.md)).

The physical D1 tables are [`packages/mcp-worker/migrations`](../packages/mcp-worker/migrations/); this sketch is the relation plan, not a column spec.

Tool behavior is specified in [`docs/PRD.md`](PRD.md) and implemented in `packages/mcp-worker`. This file does not keep a second copy of the contract.

## Phases

1. **Prototype + PRD** — done. In-memory fixture + stdio MCP explored the tool contract; retired by phase 2.
2. **v1 Worker + synthetic seed** — done. D1 schema, `seed/seed.sql`, remote MCP via `createMcpHandler`, `wrangler dev` + `pnpm demo`. Current phase.
3. **Contract deltas + tests** — `card_ids`, `as_of`, `limit` → 100, rate `unit`, `last_verified_at`, `seed_as_of`, `reports` + `report_issue`, term-kind audit → expanded term kinds; vitest + CI job.
4. **Cited seed + deploy** — popular-cards-first coverage (~15–20 most-held HK cards), real `source_url`s + `last_verified_at`, real `database_id`, workers.dev route.
5. **Playbook + maintenance live** — publish `skills/cardex`, write `skills/cardex-maintainer`, stand up the maintenance surface: `/maintainer` endpoint, `proposals` table, `/admin` portal behind Access, nightly seed export ([ADR 0002](adr/0002-maintenance-surface.md)).

## Out of scope

A consumer "which card" app, a wallet, a second approver on the portal, auth on the read path, request-time scraping, embedding search, and any store of personal data. See the ADRs.
