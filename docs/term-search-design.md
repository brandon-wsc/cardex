# Term search — current design (visual companion)

> **Status:** Experimental, live in prod. This file only *draws* [ADR 0014](adr/0014-semantic-term-search.md) — the ADR and [PRD](PRD.md) are the contract; if anything here disagrees, they win.
> Verified against `cardex.brandonhk.com/mcp` on 2026-11-16.

## 1. Big picture

```mermaid
flowchart LR
    subgraph callers
        C[Caller agent<br/>natural-language question]
        M[Maintainer agent]
    end

    subgraph worker["mcp-worker"]
        MCP(["POST /mcp<br/>search_terms"])
        MT(["POST /maintainer<br/>propose_change"])
        AP[decideProposal<br/>whitelisted patches only]
        SCHED["scheduled() reconcile<br/>every 15 min · ADR 0015"]
    end

    subgraph cloudflare["Cloudflare"]
        AI[Workers AI<br/>@cf/baai/bge-m3 · 1024d]
        VX[(Vectorize<br/>cardex-terms · cosine<br/>pointers only)]
        D1[(D1 cardex-db<br/>the only facts store)]
    end

    subgraph offline["owner-run, offline"]
        SC[scripts/term_search_index.py<br/>manual index build]
    end

    C --> MCP
    MCP -->|embed query| AI
    MCP -->|topK ids + scores| VX
    MCP -->|hydrate + revalidate| D1
    M --> MT --> AP --> D1
    SC -->|NDJSON upsert / delete list| VX
    SC -->|read terms| D1
    SCHED -->|embed + upsert / deleteByIds| VX
    AP -->|term_index_dirty<br/>same atomic batch| D1
    SCHED -->|drain marks +<br/>embed_hash sweep| D1
```

Two write paths exist; they never meet in a request:

- **Facts** — maintainer proposes → owner approves in `/admin` → `decideProposal` applies patches to D1 (and marks `term_index_dirty` in the same batch). The only path that changes truth.
- **Index** — `scheduled()` reconciles every 15 min from D1; owner can also run `term_search_index.py` → `wrangler vectorize upsert` / `delete-vectors`. Derived, rebuildable, pointers only.

## 2. Read path — `search_terms` request

```mermaid
sequenceDiagram
    participant Q as Caller
    participant S as searchTerms (query.ts)
    participant AI as Workers AI bge-m3
    participant VX as cardex-terms index
    participant DB as D1 terms

    Q->>S: query, as_of?, card_id?, limit?, detail?, min_similarity?
    alt deps missing (no AI/TERMS_INDEX binding)
        S-->>Q: {ok:false, error:"search_unavailable"}
    end
    S->>S: validate — limit ≤100, as_of, non-empty query,<br/>min_similarity ∈ [0,1], unknown card_id → empty ok page
    S->>AI: embed([query])
    AI-->>S: 1024-dim vector
    S->>VX: query(vector, topK = min(max(limit×4,32),100),<br/>returnMetadata:"none")
    VX-->>S: candidate ids + scores (deduped, order kept)
    Note over S: min_similarity floor applied here —<br/>sub-floor ids never reach D1
    S->>DB: SELECT * FROM terms WHERE id IN (order)<br/>AND effective window ∋ as_of AND card_id = ?
    DB-->>S: surviving rows (index order preserved)
    Note over S: ids with no surviving row → dropped_ids<br/>revalidation can only shrink, never grow
    S-->>Q: detail "terms" → full term rows + similarity<br/>detail "candidates" → {term_id, card_id, kind, similarity}<br/>always: total, dropped_ids, provenance
```

## 3. Index build — offline script

```mermaid
flowchart TD
    SRC{--source}
    SRC -->|default| L[local D1<br/>wrangler d1 execute --local]
    SRC -->|prod| R[remote D1]
    SRC -->|offline fallback| SEED[seed/seed.sql]

    L & R & SEED --> DOC["document = 'card_name kind text'<br/>one vector per terms row"]
    DOC --> EMB{--provider}
    EMB -->|default, free| OL[Ollama bge-m3:567m-fp16]
    EMB -->|env creds| CF[Workers AI bge-m3]
    OL & CF --> ND["terms-vectors.ndjson<br/>{id: term_id, values, metadata:<br/>card_id, kind, effective_from/to, embed_hash}"]
    ND --> UP[/"wrangler vectorize upsert<br/>cardex-terms --file"/]
    ND -.->|"--check-stale"| DIFF[list-vectors ids<br/>− live term ids]
    DIFF --> DEL[/"wrangler vectorize<br/>delete-vectors --ids"/]
```

Metadata is for diffing and debugging — `returnMetadata:"none"` at query time means the request path never even reads it. `embed_hash` (sha256 of the document) is what lets a reconcile skip unchanged rows.

## 4. Invariants

| Invariant | Enforced by |
|-----------|-------------|
| Index stores **pointers, never facts** — no term `text` in Vectorize | index builder writes id + metadata only |
| Revalidation **shrinks, never grows** — index cannot add a fact D1 wouldn't return | hydration `WHERE id IN … AND window AND card_id` |
| `similarity` is a **retrieval signal, not a fact** — no calibrated cutoff exists (wrong hits ~0.64 vs correct ~0.51 on the stress set) | raw score echoed; `min_similarity` is a caller knob, not Cardex policy |
| **Fail closed** — no silent lexical fallback | missing bindings or embed/index error → `search_unavailable` |
| Fact writes go **only** through propose→approve→apply | `decideProposal` whitelisted patches; nothing on the read path writes the index |

## 5. Degradation modes (all safe by construction)

| Situation | Caller sees |
|-----------|-------------|
| Bindings missing / embed or index error | `{ok:false, "search_unavailable"}` + `isError` |
| Stale pointer (term deleted, expired, another card's) | id lands in `dropped_ids` |
| New term approved but not yet indexed | absent — the index cannot invent it |
| Empty index | `ok` page, `total: 0` |
| Unknown `card_id` | `ok` page + `unknown_card_id` |
| No relevant term exists | low-scored candidates may still return — discovery, not proof |

## 6. Index sync — dirty marks + scheduled reconcile (ADR 0015)

N proposal approvals do not mean N index runs: marks coalesce in a set, and the cron interval is the debounce window.

```mermaid
sequenceDiagram
    participant O as Owner (/admin)
    participant AP as decideProposal
    participant DB as D1
    participant CRON as scheduled() every 15 min
    participant AI as Workers AI
    participant VX as cardex-terms

    O->>AP: approve proposal (×10 back-to-back)
    AP->>DB: apply patches + INSERT OR REPLACE into term_index_dirty<br/>(same atomic batch — marks exist iff facts do)
    Note over CRON: fires on interval —<br/>10 approvals coalesce into one run
    CRON->>VX: deleteByIds for dirty ids absent from D1
    CRON->>VX: getByIds(all live ids) → compare embed_hash
    alt document hash differs
        CRON->>AI: embed changed docs only (batches of 16)
        CRON->>VX: upsert {id, values, metadata}
    else unchanged
        Note over CRON: no embed calls, no upserts —<br/>idle run costs one getByIds + one query
    end
    CRON->>DB: clear drained marks — a throw leaves<br/>them for the next tick (ops are idempotent)
```

- **Dirty marks are the delete record** — the binding has no `listVectors`, so a deleted term is only known via the apply-time mark.
- **The `embed_hash` sweep is the insert/update reconciler** — self-heals a missed mark or an owner console edit; deletes stay mark-dependent by construction (`scripts/term_search_index.py --check-stale` remains the orphan sweeper).
- **The hook only marks, never embeds** — index failure can never roll back an approval.
- **Doc + hash byte-identical with the python builder** — `"{card_name} {kind} {text}"`, sha256 utf-8; pinned by a cross-impl spec.
