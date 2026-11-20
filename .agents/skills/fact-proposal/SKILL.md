---
name: fact-proposal
description: Cardex fact changes — build a structured-patch proposal for owner review instead of editing data files. Use whenever asked to add, update, or remove catalog facts (cards, rates, terms, tags, aliases, card fees).
---

# Fact changes — propose, never write

Facts live in prod D1 and change only through propose→approve→apply ([ADR 0002](../../../docs/adr/0002-maintenance-surface.md)). The write path is the `propose_change` tool on `POST /maintainer` (bearer `MAINTAINER_TOKEN`); the owner approves in `/admin` and the portal applies in one D1 batch. An agent can propose but never approves or applies, and holds no Cloudflare credential. Never edit `seed/seed.sql` to change facts (generated snapshot — see cardex-data), never send raw SQL (rejected — the proposal channel would itself become a write path).

## propose_change input

```
{
  "proposed_by": "…",            // optional; ignored — the server stamps "maintainer", proposals cannot be impersonated
  "summary":      "…",           // required, ≤ 500 chars — what changed and why the evidence supports it
  "evidence_url": "https://…",   // required, http(s), ≤ 2048 chars — the issuer page for the fact
  "excerpt":      "…",           // optional, ≤ 4000 chars — verbatim issuer text backing the fact
  "patches":      [ … ]          // 1–50 ops
}
```

Failure returns `{ok:false, error:"invalid_proposal"|"invalid_patch", detail}`; a full pending queue (cap 100) means wait for review, not retry. Success returns `{ok:true, proposal_id}` — it is then pending until the owner decides.

## Patch shape `{op, table, id, key?, set?}`

`table` must be in `FACT_TABLES` (`packages/mcp-worker/src/maintain.ts`): `cards, card_fees, tags, rates, rate_tags, terms, rate_terms, term_merchants, aliases, alias_tags, alias_cards`. `meta`, `reports`, `proposals`, `term_index_dirty` are off-limits. Column names come live from `PRAGMA table_info` — check `packages/mcp-worker/migrations/*.sql` for what exists.

- **insert** — `set` non-empty, must cover every NOT-NULL column. Single-pk tables: `id` fills the pk if `set` omits it; a `set` pk that differs from `id` is rejected. Multi-pk tables — `rate_tags{rate_id,tag_id}`, `rate_terms{rate_id,term_id}`, `term_merchants{term_id,merchant}`, `alias_tags{alias_text,tag_id}`, `alias_cards{alias_text,card_id}` — take their target row entirely from `set`, which must carry every pk column; `id` is only the row label.
- **update** — `set` non-empty, may not touch pk columns. Single-pk tables find the row by `id` (`key` must equal `{pk: id}` if given); multi-pk tables must name the full pk in `key`.
- **delete** — no `set`; row found by `id`/`key` as in update.

`card_fees` also passes the fee/waiver pairing rule at proposal time (ADR 0012): `fee_hkd` NULL = unresearched; `0` only with `waiver_policy = 'not_applicable'`; a nonzero fee cannot claim it. The merged row is checked, so updates must keep the pair consistent, not just the patched columns.

Apply is atomic per proposal: duplicate inserts or dangling foreign keys inside one proposal roll the whole thing back at decide time (see `decideProposal`). A patch touching `terms` or `cards` also writes a `term_index_dirty` mark on apply — index sync is automatic (ADR 0015), never propose against it directly.

## Evidence quality

The owner reviews proposals in `/admin`: one issuer URL + the verbatim `excerpt` beats a long summary. An unverifiable fact is rejected, not held.

## Checking locally

Validation rules are covered by `pnpm test` (`maintain.test.ts`); the `verify-proposal-decided-once` skill proves the decide-once guard when editing `decideProposal`. After owner apply, the next `pnpm export-seed` refresh carries the change into local dev.
