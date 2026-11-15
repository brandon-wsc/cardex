# ADR 0014 — Semantic Term discovery over a derived vector index (experimental)

- **Status:** Experimental — not yet a locked product contract
- **Date:** 2026-11-16
- **Supersedes:** the "embedding search stays out" boundary in [0002](0002-maintenance-surface.md) (and the matching PRD §11 line) — narrowly, for Term discovery only

## Context

Callers asking natural-language questions — "呢張卡要唔要登記先有回贈？", "octopus top-up 計唔計" — have no way to find a relevant Term unless they already know its id or can guess the card first. `resolve_alias` covers known tag/card names; nothing covers unknown phrasings of *conditions*. The eval recorded in [docs/vectorize-rag-research.md](../vectorize-rag-research.md) compared a lexical baseline with a local BGE-M3 embedding over the same pinned D1 Terms: dense recall@5 reached 1.0 on an unscoped Cantonese stress set where lexical scored 0.53 — and also returned candidates for all 8 no-answer cases. Similarity cannot prove a matching Term exists; it can only nominate candidates.

ADR 0002's boundary — "lookups are structured; request-time scraping and embedding search stay out" — was written when the risk was a second, unreviewed facts surface. A vector index that *answers* from stored text would be exactly that. A vector index that only *points* at D1 rows it cannot vouch for is a different object: every fact still comes from D1 at request time, and D1 revalidation can only shrink the result set, never grow it.

## Decision

1. **`search_terms(query, as_of?, card_id?, limit?, detail?)` is a new public read tool on `/mcp` and `/maintainer`.** Terms are the only semantically searchable record — cards, rates, tags, and aliases keep their structured/direct-id tools.

2. **Chunk = one curated `terms` row.** The propose→approve→apply loop already maintains one fact per row (median ~175 chars); splitting further would detach conditions from their subjects. The embedded document is `"{card_name} {kind} {text}"` — contextual context prepended for free from structured fields, not generated. Terms stay English-canonical ([ADR 0003](0003-facts-language.md)); no zh gloss is added to the embedded text — BGE-M3's cross-lingual recall was sufficient in eval, and curated glosses would create a second maintained fact surface.

3. **The index stores pointers, never facts.** Vector id = `term_id`; metadata carries `{card_id, kind, effective_from, effective_to, embed_hash}` for debugging and diffing (`embed_hash` lets a reindex skip unchanged rows). Term `text` is never stored in the index. One vector per Term; a `merchant_list` Term is one vector even when it enumerates merchants — a per-member fan-out is a later optimization if eval shows misses.

4. **Every hit is revalidated against D1 at request time.** The tool fetches vector neighbors, then hydrates from `terms` with the `card_id` filter and the `as_of` effective window. Candidates that fail — deleted, expired, or another card's rows — are dropped and echoed as `dropped_ids`. `card_id` scope is enforced at hydration, not trusted to index-side metadata filters (which the index may not have configured). Vectorize upserts propagate asynchronously, so a *new* Term may take seconds to become discoverable; hydration makes stale ids safe but cannot surface ids the index does not yet hold — acceptable for a discovery tool because degradation is to fewer candidates, never wrong facts.

5. **`detail` picks the payload, never the judgment.** `"terms"` (default) returns surviving rows in the `get_term` shape — D1 facts, provenance, effective dates. `"candidates"` returns `{term_id, card_id, kind, similarity}` pointers for a follow-up `get_term`. Every hit in either mode carries its raw `similarity` — a retrieval signal, not a fact and never a measure of applicability. Neither mode decides whether a term applies to a spend — `score_candidates` and its `unknown_exclusions` own that path, unchanged.

6. **Embeddings come from Workers AI `@cf/baai/bge-m3` (1024 dimensions, cosine index).** Query text is embedded as-is — BGE-M3 takes no query instruction prefix. The worker code takes an injected `embed` + `queryIndex` pair so tests run without billable calls; `scripts/term_search_index.py` (below) uses the same model via local Ollama by default.

7. **Index sync is a manual offline script, not a write-path hook.** `scripts/term_search_index.py` reads Terms from D1 (`wrangler d1 execute`, local or remote; the seed export is the offline fallback), embeds them, and emits NDJSON for `wrangler vectorize upsert` plus a stale-id list for `wrangler vectorize delete-vectors`. The index is derived and rebuildable; applying facts to D1 never depends on it, and nothing in the request path writes to it. An apply-time hook is a deliberate later step, not a gap.

8. **Fail closed.** Missing AI/Vectorize bindings, or an embed/index error, return `{ok: false, error: "search_unavailable"}` — the tool never silently falls back to lexical ranking (that would swap the contract underneath the caller). An empty `query` is `invalid_query`; an unknown `card_id` filter is an `ok` page with `unknown_card_id`, matching the `unknown_tag_id` pattern.

9. **No similarity threshold ships — the data says none exists.** Scoring the stress set showed wrong answers reaching ~0.64 while correct hits sat as low as ~0.51; no cutoff separates them without gutting recall. So `similarity` rides on every hit as a raw signal, and `min_similarity` (0–1) is exposed as a caller-side floor — a knob, not a Cardex policy or a relevance guarantee. A defensible abstention signal still needs independent data; until then `search_terms` is honest that its output is *discovery*: low-ranked hits may be noise, and an empty answer means "nothing survived D1 revalidation" (or the caller's own floor), not "no such term exists".

## Consequences

- The Worker gains `AI` and `TERMS_INDEX` bindings in `wrangler.jsonc`; the index (`cardex-terms`, 1024 dims, cosine) must be created and populated before deploy — the owner runs the script, matching ADR 0002's rule that agents hold no account credentials.
- `AGENTS.md` boundary 2 is amended: embedding search is permitted in the derived-index, D1-revalidated shape described here — and only for Terms.
- This ADR is **Experimental**: it records a reversible prototype. Promotion to Accepted needs real-query evidence that recall holds, a no-answer posture that does not mislead, and an index-sync cadence the owner accepts; retirement needs only deleting the tool, the binding, and the index — D1 is untouched either way.
- Index staleness is observable (`dropped_ids`) but not alarming: a Term deleted in D1 keeps no dangerous residue because hydration hides it; the residue is only wasted index space until the script's delete list runs.
