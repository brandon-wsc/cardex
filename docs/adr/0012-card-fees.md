# ADR 0012 — Card fees as their own record, with community-cited waiver practice

- **Status:** Accepted
- **Date:** 2026-11-15
- **Supersedes:** —

## Context

Callers need the annual fee to judge whether a card's earn is worth its cost. Two facts of different reliability are involved: the **stated fee** (issuer KFS / tariff — citable) and **waiver practice** (whether the fee is actually charged). The second has no firm issuer policy — banks publish at most "may be waived" boilerplate, while the operational reality (call retention and it is waived, or never waived) lives in community reporting (Fly for Miles 小斯, 里先生) and holder anecdotes. Issuer-only sourcing would leave the field permanently empty; treating a blog citation as equal to a T&C would overstate it.

Modeling options considered:

- **`terms` kind `annual_fee`** — reuses the provenance/window machinery, but stretches "term = a condition on a card or rate" past what the glossary and the scoring pipeline assume, and card-level terms are invisible to the tools today: only rate-linked terms surface in `get_card`.
- **Columns on `cards`** — the fee and its waiver carry separate sources and check dates; five more columns would fragment per-fact provenance across one row.
- **`card_fees` table (chosen)** — a fee is a record on the card, not a condition: a vertical partition of card facts, one row one citation.

## Decision

1. New facts table `card_fees`: `id`, `card_id`, `kind` (starts as `'annual'` only — joining/supplementary fees stay in `text` until needed), `fee_hkd` (NULL = a fee exists but the amount is unresearched), `waiver_policy`, `waiver_source_url`, `text`, `source_url`, `last_verified_at`, `effective_from`, `effective_to`.
2. `waiver_policy` is a closed vocabulary: `not_applicable` (fee is 0), `first_year`, `spend_threshold`, `conditional` (other issuer-published conditions, e.g. relationship balance), `on_request` (community-reported), `none_known` (researched, no waiver found), `unknown` (not researched). Nuance goes in `text`, never in new enum values.
3. Two citations per row: `source_url` cites the fee (issuer KFS/tariff); `waiver_source_url` cites the waiver claim. A community post is acceptable there — `waiver_policy: on_request` already marks the claim as practice rather than policy, and a NULL `waiver_source_url` on a reported waiver is itself the unverifiable-anecdote signal.
4. Coverage is explicitly three-state: no row = not researched; `fee_hkd = 0` + `not_applicable` = verified "no annual fee"; a row with `waiver_policy = 'unknown'` = fee known, waiver unchecked.
5. `get_card` returns `fees` inline (at most a few rows per card, so no id-chasing), each carrying the same `illustrative` rule and folded into payload `provenance`. `lookup_rates` and `score_candidates` never see fee rows — a fee is per-year and does not enter per-spend math; the caller combines them itself.

## Consequences

- `get_card` is the only read surface for fees — no card-discovery filter by `waiver_policy`; the catalog is small enough that per-card reads suffice.
- `report_issue` targets fees via `card_id` + `field` (e.g. `"annual_fee"`) — no `fee_id` target until triage needs it.
- `card_fees` joins the capability boundary in `maintain.ts` and the export/data-check table lists, so proposals, seed export, and integrity rules cover it like any facts table.
- A blog-cited fee row still counts as verified under [ADR 0005](0005-record-provenance.md)'s rule (real URL + `last_verified_at`); that is accepted — provenance says "has a real citation", and the enum value plus the URL domain carry the reliability signal. If callers later need to machine-filter community sources, a `source_kind` field can be added without a table rebuild.
