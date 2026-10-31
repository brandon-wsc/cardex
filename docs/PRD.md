# Cardex — PRD

Status: Draft v0.3 · Owner: Brandon · Last updated: 2026-10-31

Cardex is a pair: a **playbook** that teaches a personal agent how to reason about Hong Kong credit cards, and a **facts backend** — a Cloudflare Worker in `packages/mcp-worker`, a public remote MCP endpoint backed by D1. The playbook ships in `skills/cardex` ([ADR 0001](adr/0001-product-shape.md)); this document specifies the backend and its contract. Query data is the synthetic seed in `seed/seed.sql` — invented numbers, not issuer terms.

---

## 1. Problem & Goal

Personal agents get asked "which card for this spend". Today they guess, or they scrape — and what they scrape in Hong Kong is affiliate-ranked comparison content and issuer T&C PDFs: biased toward commission, and easy to parse wrong.

**Goal:** an agent installs a playbook (what to check: registration requirements, foreign-currency fees, caps, exclusions, effective windows) backed by a public facts endpoint it can query mid-conversation. Facts from Cardex; judgment stays with the caller ([ADR 0001](adr/0001-product-shape.md)).

**Non-goal:** telling anyone which card to get.

## 2. Callers & Context

Callers are **anyone's** personal agents. One playbook, three ways in:

| Caller | Context | How it reaches Cardex |
|---|---|---|
| **Harness agent** | Installs `skills/cardex` into its agent | Remote MCP at `/mcp` |
| **Web chatbot** | Claude / ChatGPT / Gemini / Grok — user adds a connector or custom app | Remote MCP — public, unauthenticated ([ADR 0001](adr/0001-product-shape.md)) |
| **Anything else** | Can read the playbook but connect nothing | Pasteable playbook text — degraded but still useful |

The endpoint is public read-only: no accounts, no tokens. All write authority sits at the repo merge layer ([ADR 0001](adr/0001-product-shape.md)).

### Suggest → confirm

Cardex never sees a wallet. The flow the playbook teaches:

1. The caller asks Cardex which cards and rates apply to a spend (`resolve_alias`, `lookup_rates`).
2. The caller suggests candidate cards to its user; the user confirms which they hold.
3. The caller scores the confirmed set via `card_ids`, or scans the catalog for the unheld comparison.

Wallet state lives in the caller's memory. Cardex stores none of it ([ADR 0001](adr/0001-product-shape.md)).

### Design implications

- Every list tool takes `limit` (default 5, max 100, clamped).
- Records carry ids so the next call can be `get_card` / `get_term`.
- Every payload carries `provenance` and `seed_as_of`, so a caller knows how stale an answer could be.

## 3. Data Model

Language is in [`CONTEXT.md`](../CONTEXT.md). This section is the v1 data model; the physical tables are in [`packages/mcp-worker/migrations`](../packages/mcp-worker/migrations/).

### 3.1 Records

| Record | Fields | Notes |
|---|---|---|
| **Tag** | `id`, `label`, `kind` | Canonical spend class. `kind` is `channel` or `category`. Tags overlap |
| **Card** | `id`, `name`, `issuer`, `network` | A product, not someone's plastic |
| **Rate** | `id`, `card_id`, `kind`, `value`, `unit`, `tag_ids`, `term_ids` | `kind` is `rebate_percent` or `points`. `value` + `unit` preserve the published figure and its unit (e.g. `4` + `hkd_per_mile`, `2` + `points_per_hkd`) — never a normalized bare float |
| **Term** | `id`, `card_id`, `kind`, `text`, `source_url`, `last_verified_at`, `effective_from`, `effective_to` | v1 kinds: `cap`, `exclusion`. Planned, pending the term-kind audit: `fx_fee`, `min_spend`, `registration_required`, `channel`, `mcc` |
| **Alias** | `text`, `tag_ids`, `card_ids`, `issuers`, `networks` | Free text → those refs. Tag/card mappings live in D1 (`alias_tags`, `alias_cards`); issuer/network mappings live in `src/aliases.ts` — both sets are near-closed, so one file keeps the whole map reviewable. Values are canonical strings matching `cards.issuer` / `cards.network`. Any side may be empty |
| **Report** | `id`, `target_id`, `field`, `claimed_value`, `evidence_url`, `note`, `reported_at` | Quarantine table. Query tools never read it; only the maintenance loop does |

### 3.2 What a rate does not include

The rate row does not embed the term body. The caller follows `term_ids` with `get_term`. That keeps `lookup_rates` small.

### 3.3 Effective windows

Records carrying `effective_from`/`effective_to` — terms today; rates too, if the audit shows promos expire at rate level — are filtered by `as_of` (default: today) in list and score tools. `effective_to` NULL is open-ended. `get_card` and `get_term` by id return the record regardless — an explicit fetch is for auditing, not filtering. A stale seed degrades to fewer answers, not wrong ones ([ADR 0001](adr/0001-product-shape.md)).

## 4. Tools

Shared envelope on every success and failure:

```json
{ "provenance": { "kind": "synthetic-seed", "illustrative": true, "note": "…" }, "seed_as_of": "2026-10-31" }
```

`limit` above 100 is clamped. The payload echoes `limit_requested` and `clamped: true`. `limit` below 1 is `invalid_limit`. Omitted `limit` becomes 5. There is no offset by design — the catalog is small, and follow-up reads are by `id`.

| Tool | Input | Returns |
|---|---|---|
| `lookup_rates` | `tag_id?`, `card_ids?: string[]`, `issuer?`, `as_of?`, `limit?` | Matching rates, all filters AND. Each row: rate id, card id and name, issuer, kind, value, unit, tag ids, term ids. `total` is the pre-limit count. Unknown `tag_id` → empty page plus `unknown_tag_id` |
| `get_card` | `id` | One card, its rate summaries, the term ids those rates cite. Unknown id → `not_found` |
| `get_term` | `id` | One term. Unknown id → `not_found` |
| `list_tags` | `limit?` | Tag id + label |
| `resolve_alias` | `query`, `limit?` | Each hit: the alias text, tag ids, card ids, issuers, networks. DB aliases and the code-side issuer/network maps are merged by alias text. No hit → `matches: []`. Match is normalized (trim, lowercase, collapsed spaces): exact, or either string contains the other when both are at least 2 characters |
| `score_candidates` | `amount_hkd`, `tag_ids?`, `card_ids?`, `alias?`, `assumptions?`, `as_of?`, `limit?` | One row per matching rate. See §5 |
| `report_issue` | exactly one of `card_id` / `rate_id` / `term_id`, `field`, `claimed_value`, `evidence_url?`, `note?` | `{ ok: true, report_id }`. Writes only to the reports table. There is no public read-back tool |

Failures are `{ ok: false, error, detail? }` plus the same provenance. They are not a thrown stack.

`report_issue` asks for evidence (`evidence_url`) and its description tells callers not to include personal data. It is a suggestion box that feeds the maintenance loop — never a write path to facts ([ADR 0001](adr/0001-product-shape.md)).

## 5. score_candidates

Inputs:

- `amount_hkd` — must be > 0, else `invalid_amount`.
- `card_ids?` — restricts scoring to those cards. This is the held-set path after the user confirms their wallet; Cardex never learns why the set was chosen. Alias hits contribute their `card_ids` to the same scope.
- Tags come from `tag_ids` and from `alias` (via the same match as `resolve_alias`). No tags at all → `missing_spend`.
- `as_of` — filters windowed terms. Default today.
- `assumptions.month_to_date_rebate_hkd` — rebate already earned this period, used only to apply a cap.
- `assumptions.hkd_per_point` — how the caller values one unit (point or mile) of a `points` rate's `unit`.
- `assumptions.checked_exclusions` — exclusion keys the caller asserts do **not** apply. May also carry `fx_fee:<term id>` to settle a foreign-currency fee.

For each matching rate:

| Situation | What the row does |
|---|---|
| `rebate_percent` | `calculated_rebate_hkd = amount × value / 100` |
| `points` and `hkd_per_point` is set | `calculated_rebate_hkd` computed per the rate's `unit` (e.g. `amount × value × hkd_per_point` for `points_per_hkd`; `amount / value × hkd_per_point` for `hkd_per_mile`) |
| `points` and `hkd_per_point` is absent | `calculated_rebate_hkd: null`. `unknown_exclusions` includes `points_value` |
| Cap term, month-to-date **absent** | Do not clamp. `unknown_exclusions` includes `cap_remaining:<term id>` |
| Cap term, month-to-date **present** | Clamp to `max(0, cap_hkd − month_to_date)` |
| `fx_fee` term not settled | Rebate stands; `unknown_exclusions` includes `fx_fee:<term id>` — the caller nets it |
| Term outside its effective window at `as_of` | Not applied. `unknown_exclusions` includes `term_outside_window:<term id>` |
| Exclusion key **not** in `checked_exclusions` | Leave the number. List the key in `unknown_exclusions` |
| Exclusion key **in** `checked_exclusions` | Treat it as cleared. Do not list it |

Rows are ordered by `card_id`, then `rate_id`. There is no `winner`, no rank, and no "best" field. The caller sorts if it wants to.

A cleared exclusion is the caller saying "this does not apply", not Cardex deciding the spend is eligible.

## 6. States

| State | Behaviour |
|---|---|
| No rates match | `ok: true`, `records: []`, `total: 0` |
| Unknown card or term id | `ok: false`, `error: "not_found"` |
| Unknown tag on lookup | `ok: true`, empty page, `unknown_tag_id` set |
| Alias matches nothing | `ok: true`, `matches: []` |
| `limit` above 100 | Clamped, `clamped: true` |
| Score with no tag and no usable alias | `ok: false`, `error: "missing_spend"` |
| Cap or exclusion the caller did not settle | Row still returned. The gap is in `unknown_exclusions` |
| Report accepted | `ok: true`, `report_id`. Lands in quarantine, never in query tables |
| Report missing target, `field`, or `claimed_value` | `ok: false`, `error: "invalid_report"` |

## 7. Seed Strategy

Current seed is **synthetic**: four cards, a handful of rates, every number invented for the shape, `provenance.illustrative: true`, `source_url` placeholder. Do not cite these figures.

The **cited seed** is the next milestone and follows a different rule: cover the cards most people actually hold — roughly the 15–20 most-held HK cards (the power-law head), not the whole market. Every value carries a real `source_url` and `last_verified_at`. The owner signs off each figure by merging the PR that carries it ([ADR 0001](adr/0001-product-shape.md)).

`pnpm demo` migrates and seeds local D1, boots `wrangler dev`, and prints payloads from a real MCP client.

## 8. Maintenance Loop

The seed stays true through a loop, not a crawl ([ADR 0001](adr/0001-product-shape.md)):

1. **Triage** — the maintenance agent (grokbot) runs scheduled passes: re-check terms whose `effective_to` is near or `last_verified_at` is oldest, plus whatever the owner points it at.
2. **Propose** — it opens a PR against `seed/seed.sql` with evidence: term id, old → new value, `source_url`, fetch date, excerpt.
3. **Approve** — the owner reviews and merges. The merge is the only write path to facts.
4. **Apply** — the merged seed is loaded into D1.

`report_issue` submissions join the same triage queue. `skills/cardex-maintainer` is the agent's runbook — a separate artifact from the caller-facing playbook.

## 9. Suggested Tech (v1)

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Cloudflare Workers (`wrangler dev` locally) | Remote MCP per [ADR 0001](adr/0001-product-shape.md) |
| Language | TypeScript | Workers standard |
| Protocol | `createMcpHandler` (agents SDK) wrapping `McpServer` (`@modelcontextprotocol/server`, SDK v2) | Stateless streamable HTTP at `/mcp`; `McpAgent` is deprecated |
| Store | D1 | Query store and offline seed per [ADR 0001](adr/0001-product-shape.md) |
| Query | Async functions in `query.ts` against `env.DB` | Tool I/O authority; the demo and the Worker call the same functions |
| Seed | `seed/seed.sql` via `wrangler d1 execute --local` | Idempotent, auditable in git |
| Tests | vitest over `query.ts` + CI job | §5 logic is pure; behavior is the gate ([TESTING.md](TESTING.md)) |

Dependencies are pinned. `.npmrc` refuses a release younger than 7 days.

## 10. Scope & Priorities

| P | Feature |
|---|---|
| **P0** (done) | D1 schema + synthetic seed, the six tools, provenance on every payload, `limit` cap, `wrangler dev` + `pnpm demo` |
| **P1** | Contract deltas — `card_ids`, `as_of`, `limit` → 100, rate `unit`, `last_verified_at`, `seed_as_of`, `reports` table + `report_issue`, expanded term kinds (post-audit); vitest + CI test job |
| **P2** | Cited seed (popular-cards-first), real `database_id` + workers.dev route, playbook content in `skills/cardex`, `skills/cardex-maintainer` + the live maintenance loop |
| **P3** | Rate limiting if abuse shows up, pasteable packaging for non-MCP clients, freshness cadence tuning |

## 11. Out of Scope

A consumer "which card" app, a wallet, an admin panel (pull requests are the approval surface), auth on the read path, request-time scraping, embedding search, personal data of any kind, and any copy that names a best card.

## 12. Open Questions

1. Which term kinds survive the audit — do `fx_fee`, `min_spend`, `registration_required`, `channel`, `mcc` cover what real HK offers actually need, or are there more?
2. Do rates themselves carry effective windows, or does a promo rate model as rate + dated term?
3. The cited-seed card list — which ~15–20 most-held cards? Owner picks; the maintenance agent researches.
4. Does `score_candidates` still ship to real callers only once the cited seed lands?
5. `period` on caps — statement month, calendar month, or promo window? The audit answers which forms exist; `period` stays a field on the term.
6. Maintenance cadence — weekly or biweekly scheduled passes, and what reactive triggers exist beyond the owner asking?
7. `report_issue` at scale — when does rate limiting move from P3?
8. `unit` vocabulary on rates — a fixed enum or an open string?
