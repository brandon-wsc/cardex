---
name: cardex-data
description: Cardex local-D1 data lifecycle — migrate, seed, facts-integrity check, refresh the prod snapshot. Use when loading/rebuilding seed.sql, refreshing the local database, checking fact integrity, or adding a data-check rule.
---

# D1 data lifecycle

Facts live in prod D1; `seed/seed.sql` is a generated dev snapshot ([ADR 0002](../../../docs/adr/0002-maintenance-surface.md)) — never the truth, never hand-edited.

## Commands

```bash
pnpm migrate       # apply packages/mcp-worker/migrations to local D1
pnpm seed          # load seed/seed.sql into local D1
pnpm data:check    # migrate + seed, then facts-integrity rules vs loaded D1
pnpm export-seed   # rebuild seed/seed.sql from prod D1 — needs owner-authenticated wrangler
```

## The snapshot

`pnpm export-seed` runs `scripts/export-seed.sh`: `wrangler d1 export --remote --no-schema` restricted to the 12 facts tables, then prepends `DELETE FROM` for every table (children before parents) and appends `seed/fixtures.sql` — local-dev rows for `reports`/`proposals`, which are never exported (quarantined submissions + audit trail). Idempotent: clears and re-inserts. `term_index_dirty` is ops state — never dumped, cleared on reload ([ADR 0015](../../../docs/adr/0015-term-index-sync.md)). The committed file carries no date stamp, so diff noise means real drift.

## Facts-integrity gate

`scripts/data-check.mjs` runs semantic rules that cannot live in DDL — one SELECT per rule returning only violation rows:

1. Orphan FKs on every declared facts relation (rates/terms→cards, both sides of rate_tags, rate_terms, term_merchants, alias_tags, alias_cards).
2. `unit` matches `kind` — rebate_percent is `percent`; points uses the units `score_candidates` interprets (points_per_hkd, hkd_per_mile, hkd_per_point).
3. `rates.value > 0`.
4. Closed effective windows ordered: `effective_from <= effective_to`.
5. `exclusive_group` pairs with integer `priority` (NULL for ungrouped rates).

Exception: the card_fees fee/waiver pairing rules ARE restated in DDL (migration 0005 CHECKs). Their audit queries stay for snapshot forensics with `ddlEnforced` — the selftest requires the schema itself to reject the planted write.

Before querying the real DB the script self-tests: rebuild migrations + seed in memory, plant a violation per rule, require the check to catch it — a silently broken check cannot go green. `node scripts/data-check.mjs --selftest-only` runs just the proof, no D1 needed. Exit 1 prints offending row ids. CI runs it on every PR, no path filter.

## Adding a rule

Add a CHECKS entry in `scripts/data-check.mjs`: one SELECT returning only violators, plus the planted-violation selftest. If the rule is DDL-enforceable prefer a migration CHECK with `ddlEnforced: true` — but migrations ride the owner-review gate. Test via `--selftest-only`, then full `pnpm data:check`.
