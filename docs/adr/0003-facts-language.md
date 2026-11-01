# ADR 0003 — Facts are English-canonical; other languages live in the lookup layer

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

Callers ask Cardex in Cantonese and written Chinese at least as often as English, and HK issuers publish terms in both. Two options were on the table: store facts bilingually (or in Chinese), or keep one canonical language and solve Chinese at lookup.

- **A translated fact is a derived fact.** Every value carries `source_url` provenance ([ADR 0001](0001-product-shape.md)). A `terms.text` translated by the maintenance agent is one step removed from its source, and legal nuance — network country codes, rolling-window anchors, exclusion scope — drifts silently in translation. The reader cannot tell which sentences are issuer text and which are ours.
- **The caller is an agent, not a person.** It renders in whatever language its user speaks. Cardex's job is accurate structured facts; presentation language is the caller's problem. Storing zh facts would not save the caller any work — it still merges Cardex output with its own reasoning in the user's language.
- **The lookup gap was real but narrower than "the seed should be Chinese".** `resolve_alias` already maps free text in any language to tags, cards, issuers, and networks (`alias_tags`/`alias_cards` in D1; the near-closed issuer/network maps in `src/aliases.ts`). What could not be reached in Chinese was `merchant_list` membership: `score_candidates(merchant)` matches against `term_merchants` rows directly and never consults the alias table, so a whitelist holding only 'Sushiro' stays `unknown` when the caller passes 壽司郎.

## Decision

1. **Fact fields stay in the source's operative language — English unless a fact exists only in Chinese.** `cards.name`, `tags.label`, `terms.text`, `term_merchants.merchant`, and any future fact text are canonical in English. When a Chinese-only source must be stored, the row keeps the original text and the proposal records the translation in its `excerpt`/`note`; the fact itself is not silently translated.
2. **Chinese coverage is data entered in the lookup layer, not a second language in facts.** `aliases` rows map zh merchant, nickname, and spend-word text to tags and cards; `ISSUER_ALIASES`/`NETWORK_ALIASES` hold the zh issuer and network names.
3. **`term_merchants` carries every known name form of a member** — one row per form ('Sushiro', '壽司郎'; 'TamJai', '譚仔'). Whitelist membership is an existence check, so extra name forms can only produce hits, never false non-membership. Merchant names do not go through `aliases` — an alias resolves to a spend class or a card, not to a term's member list.
4. **The caller renders the end-user language.** Tool payloads stay English; the playbook tells callers to answer in the user's language.

## Consequences

- `seed/seed.sql` stays English at the fact rows; zh strings appear only in `aliases`, `alias_tags`, `alias_cards`, and `term_merchants`.
- Proposals that add zh alias or `term_merchants` rows are ordinary fact patches through the normal propose→approve→apply loop — no schema or code change ([ADR 0002](0002-maintenance-surface.md)).
- The vitest fixture pins a zh `term_merchants` member so the match-any-form behaviour is spec'd, not assumed.
- A future localized-text design (e.g. a `term_texts` table keyed by lang) is a schema change needing owner review and a superseding ADR; until then, translation for display happens at the caller.
