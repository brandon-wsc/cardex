# ADR 0015 — Term-index sync via apply-time dirty marks + scheduled reconcile

- **Status:** Accepted
- **Date:** 2026-11-16
- **Supersedes:** [0014](0014-semantic-term-search.md) decision 7 ("Index sync is a manual offline script, not a write-path hook"). Every other 0014 decision stands — the index still stores pointers only, and the experimental `search_terms` contract is unchanged.

## Context

ADR 0014 shipped `search_terms` with index sync as a manual script, noting an apply-time hook was "a deliberate later step, not a gap". Within a day the index drifted: live calls already echo `dropped_ids` for stale pointers. The question was how to make sync automatic without violating "applying facts to D1 never depends on the index".

Two constraints shape the design. The `VectorizeIndex` binding exposes `getByIds`, `upsert`, `deleteByIds` — but **no `listVectors`** (list exists only in wrangler CLI / REST). And Cloudflare offers no D1 change events: SQLite triggers run SQL only and cannot reach a Worker, Queue, or Vectorize; R2-style event notifications do not cover D1. So a delete can only be detected where the delete is *written* — inside `decideProposal`, the single sanctioned write path.

## Decision

1. **`term_index_dirty` is the delete record.** A new ops table (`term_id TEXT PRIMARY KEY, queued_at`). During `decideProposal`'s approve path, every patch touching `terms` marks its own id; every `cards` patch marks all of that card's terms (a rename changes the `card_name` inside each embedded document). The marks ride inside the same `db.batch` as the fact patches — they exist iff the facts landed. PK dedupe makes N approvals coalesce for free; each mark's `queued_at` carries an `iso#uuid` token so the reconcile's exact-value drain can never wipe a re-mark that merely shares the same millisecond. Not in `FACT_TABLES`: proposals cannot patch it, and it is never exported to the seed.

2. **The hook only marks — it never embeds.** Embedding or index failure can never roll back an approval, and nothing waits on propagation.

3. **A `scheduled` handler reconciles every 15 minutes** (`triggers.crons` in `wrangler.jsonc`). Each run: (a) `deleteByIds` for every dirty id absent from D1; (b) sweep — `getByIds` on all live term ids, compare `metadata.embed_hash` to a freshly computed document hash, embed + `upsert` only the drifters; (c) clear the marks. Any throw keeps the marks for the next tick — upserts and deletes are idempotent.

4. **The sweep is the correctness floor; marks are the delete signal.** Because the index cannot be enumerated, inserts and content drift are reconciled by the hash sweep even if a mark were somehow missed (a future code path, an owner console edit). Deletion remains mark-dependent by construction — that is the trade the missing `listVectors` forces, accepted because hydration already hides stale pointers safely.

5. **The document and hash are byte-identical with `scripts/term_search_index.py`** (`"{card_name} {kind} {text}"`, sha256 utf-8 hex). The script and the worker share the index; a drifted format would re-embed every term every run. `EMBED_BATCH` is 16 on both sides.

6. **An idle run costs no billable calls.** `getByIds` + one D1 query; embeddings are made only when a hash actually differs. Missing AI/index bindings skip the run, matching `search_terms`' fail-closed posture.

## Consequences

- Migration `0006_term_index_dirty.sql` + `triggers.crons` — the migration rides the normal deploy workflow and the owner-review schema gate.
- `scripts/term_search_index.py` stays: it is still the full-rebuild path and the only stale-*id* reaper (`--check-stale` lists index ids a mark-based system cannot see). Its `--check-stale` delete list remains the orphan sweeper.
- Mixed embedding implementations: the deployed index was built via Ollama `bge-m3:567m-fp16` while the worker embeds via Workers AI `@cf/baai/bge-m3`. Serving implementations are not presumed numerically identical; the owner should re-embed once with `--provider cloudflare` so index and query path share one implementation. The hash sweep will then keep it uniform.
- Worst-case discoverability of a newly approved term: cron interval + Vectorize propagation (minutes). Acceptable per 0014 — degradation is fewer candidates, never wrong facts.
