---
name: term-search
description: Cardex term-search machinery — eval and rebuild the BGE-M3 Vectorize index behind search_terms. Use when working on search_terms, scripts/term_search_*.py, term-index-sync.ts, or the cardex-terms index.
---

# Term search — eval and index sync

`search_terms` (experimental, [ADR 0014](../../../docs/adr/0014-semantic-term-search.md)) discovers candidate Terms by embedding `"{card_name} {kind} {text}"` with BGE-M3 into the `cardex-terms` Vectorize index, then revalidating every hit against D1 at request time. The index stores pointers only — vector id = term id, metadata `{card_id, kind, effective_from, effective_to, embed_hash}` — and term text never enters it.

Read ADR 0014 (contract) and [ADR 0015](../../../docs/adr/0015-term-index-sync.md) (sync design) before changing the tool, the index, or the document/hash format.

## Layout

| Piece | Where |
|-------|-------|
| Manual eval | `scripts/term_search_eval.py` (+ `term-search-eval-cases.json`, `term-search-eval-stress-cases.json`) |
| Index builder | `scripts/term_search_index.py` |
| Offline tests | `python3 -m unittest discover -s scripts -p 'test_term_search*.py'` |
| Worker reconcile | `packages/mcp-worker/src/term-index-sync.ts` (+ `.test.ts`) — cron every 15 min |
| Writeup | `docs/vectorize-rag-research.md`, `docs/term-search-design.md` |

## Eval

```bash
python3 scripts/term_search_eval.py                   # lexical baseline vs pinned local seed — fully offline
python3 scripts/term_search_eval.py --provider ollama # add dense recall (needs ollama serve + pulled bge-m3:567m-fp16)
python3 scripts/term_search_eval.py --help            # --remote, --card-id, --as-of, case-set options
```

## Manual index rebuild

```bash
pnpm migrate && pnpm seed                # local D1 must be loaded first
ollama serve &                           # plus `ollama pull bge-m3:567m-fp16` once
python3 scripts/term_search_index.py     # reads local D1, emits:
#   scripts/out/terms-vectors.ndjson  -> wrangler vectorize upsert cardex-terms --file ...
#   scripts/out/stale-vector-ids.txt  -> wrangler vectorize delete-vectors cardex-terms --ids ...
```

- `--remote` reads prod D1 instead of local; the seed export is the offline fallback.
- `--provider cloudflare` re-embeds with the Worker's own implementation — the deployed index was Ollama-built; serving implementations are not numerically identical, so re-embed once so index and query path match (ADR 0015).
- `--check-stale` diffs live index ids via `wrangler vectorize list-vectors` — the only orphan sweeper, since the binding exposes no `listVectors`.
- Uploading needs owner-authenticated wrangler; an agent can build the artifacts but the owner upserts.

## Invariants — changing either side breaks sync

- Document `"{card_name} {kind} {text}"` and its sha256-utf8 `embed_hash` are byte-identical between `term_search_eval.py`/`term_search_index.py` and `term-index-sync.ts`; `EMBED_BATCH = 16` on both sides. Drift makes the 15-minute sweep re-embed every term every run.
- A `cards` rename re-embeds all of that card's terms (card_name is inside the document) — the approve hook marks them in `term_index_dirty`.
- Coverage is layered: inserts/content-drift reconcile by the cron hash sweep; deletes only by dirty marks; orphan index ids only by `--check-stale`.
- `search_terms` fails closed (`search_unavailable`, no lexical fallback) and `similarity` is a raw retrieval signal — never a fact and never a relevance guarantee.
