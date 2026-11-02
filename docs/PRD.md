# Cardex — PRD

Status: Draft v0.4 · Owner: Brandon · Last updated: 2026-11-01

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

The endpoint is public read-only: no accounts, no tokens. Writes live on two authenticated surfaces — `/maintainer` for the maintenance agent (proposals only) and `/admin` for the owner (approvals) — never on the public path ([ADR 0002](adr/0002-maintenance-surface.md)).

### Suggest → confirm

Cardex never sees a wallet. The flow the playbook teaches:

1. The caller asks Cardex which cards and rates apply to a spend (`resolve_alias`, `lookup_rates`).
2. The caller suggests candidate cards to its user; the user confirms which they hold.
3. The caller scores the confirmed set via `card_ids`, or scans the catalog for the unheld comparison.

Wallet state lives in the caller's memory. Cardex stores none of it ([ADR 0001](adr/0001-product-shape.md)).

### Design implications

- Every list tool takes `limit` (default 5, max 100, clamped).
- Records carry ids so the next call can be `get_card` / `get_term`.
- Every payload carries `provenance` and `seed_as_of`, so a caller knows how stale an answer could be. `provenance` is computed per payload from the returned records — see §4 — and each rate and term row carries its own `source_url`, `last_verified_at`, and `illustrative` flag ([ADR 0005](adr/0005-record-provenance.md)).

## 3. Data Model

Language is in [`CONTEXT.md`](../CONTEXT.md). This section is the v1 data model; the physical tables are in [`packages/mcp-worker/migrations`](../packages/mcp-worker/migrations/).

### 3.1 Records

| Record | Fields | Notes |
|---|---|---|
| **Tag** | `id`, `label`, `kind` | Canonical spend class. `kind` is `channel` or `category`. Tags overlap |
| **Card** | `id`, `name`, `issuer`, `network` | A product, not someone's plastic |
| **Rate** | `id`, `card_id`, `kind`, `value`, `unit`, `tag_ids`, `term_ids`, `exclusive_group`, `priority` | `kind` is `rebate_percent` or `points`. `value` + `unit` preserve the published figure and its unit (e.g. `4` + `hkd_per_mile`, `2` + `points_per_hkd`) — never a normalized bare float. Rates sharing an `exclusive_group` cannot stack; the caller keeps the best `priority` per group |
| **Term** | `id`, `card_id`, `kind`, `text`, `source_url`, `last_verified_at`, `effective_from`, `effective_to`, kind fields | Kinds are audited against real issuer mechanics ([term-kind-audit.md](term-kind-audit.md)): `cap`, `exclusion`, `fx_fee`, `min_spend`, `registration_required`, `channel`, `mcc`, `quota`, `merchant_list`, `geo`, `targeted`, `eligibility`. Kind fields are sparse: `cap_hkd`, `threshold_hkd` (min_spend), `quota_n`, `register_by`, `post_within_days`, `anchor` + `anchor_days` (rolling windows), `period`, `exclusion_key`. `merchant_list` members live in `term_merchants` |
| **Alias** | `text`, `tag_ids`, `card_ids`, `issuers`, `networks` | Free text → those refs. Tag/card mappings live in D1 (`alias_tags`, `alias_cards`); issuer/network mappings live in `src/aliases.ts` — both sets are near-closed, so one file keeps the whole map reviewable. Values are canonical strings matching `cards.issuer` / `cards.network`. Any side may be empty |
| **Report** | `id`, `target_id`, `field`, `claimed_value`, `evidence_url`, `note`, `reported_at` | Quarantine table. Query tools never read it; only the maintenance loop does |

`period` vocabulary observed in the wild (open string, not an enum): `statement_month`, `statement_cycle`, `calendar_month`, `promo_period`, `promo_phase`, `event_date`, `rolling_window`, `per_transaction`, `none`.

### 3.4 Language of facts

Fact fields are English-canonical ([ADR 0003](adr/0003-facts-language.md)). Non-English coverage lives in the lookup layer: `aliases` maps zh merchant, nickname, and spend-word text to tags and cards; `ISSUER_ALIASES`/`NETWORK_ALIASES` map zh issuer and network names; `term_merchants` holds one row per known name form of a whitelist member. The caller renders the end-user's language — payloads stay English.

### 3.2 What a rate does not include

The rate row does not embed the term body. The caller follows `term_ids` with `get_term`. That keeps `lookup_rates` small.

### 3.3 Effective windows

Rates and terms both carry `effective_from`/`effective_to` — promo uplifts expire at rate level in the wild ([audit §c](term-kind-audit.md)). They are filtered by `as_of` (default: today) in list and score tools. `effective_to` NULL is open-ended. `get_card` and `get_term` by id return the record regardless — an explicit fetch is for auditing, not filtering. A stale seed degrades to fewer answers, not wrong ones ([ADR 0001](adr/0001-product-shape.md)).

## 4. Tools

Shared envelope on every success and failure:

```json
{ "provenance": { "kind": "synthetic-seed" | "mixed-seed" | "cited-seed", "illustrative": true | false, "note": "…" }, "seed_as_of": "2026-10-31" }
```

`provenance` is computed per payload, not a fixed constant. A rate or term record is **verified** when `source_url` is a real URL — anything but the seed placeholder host `example.invalid` — and `last_verified_at` is set; every other record is `illustrative: true`. The envelope summarizes the fact records the payload returned: `cited-seed` (`illustrative: false`) when all are verified, `mixed-seed` (`illustrative: true`) when some are, and `synthetic-seed` (`illustrative: true`) when all are — or when the payload carries no fact records at all (errors, empty pages, tag and alias lists, report acknowledgements). The per-record `illustrative` flag is the truth; the envelope is the summary.

`limit` above 100 is clamped. The payload echoes `limit_requested` and `clamped: true`. `limit` below 1 is `invalid_limit`. Omitted `limit` becomes 5. There is no offset by design — the catalog is small, and follow-up reads are by `id`.

Tool inputs are strict objects: an unrecognized key (`tag` instead of `tag_id`, `cards` instead of `card_ids`) is a protocol-level `InvalidParams` error, never a silently dropped filter. The error names the rejected keys and lists the valid ones.

| Tool | Input | Returns |
|---|---|---|
| `lookup_rates` | `tag_id?`, `card_ids?: string[]`, `issuer?`, `as_of?`, `limit?` — at least one of `tag_id` / `card_ids` / `issuer` is required | Matching rates, all filters AND. Each row: rate id, card id and name, issuer, kind, value, unit, tag ids, term ids, `source_url`, `last_verified_at`, `illustrative`. `total` is the pre-limit count. The payload echoes the applied filters as `filters: { tag_id, card_ids, issuer, issuer_canonical, as_of }`. `issuer` compares against the canonical `cards.issuer` string (normalized) or resolves through the issuer alias map via the same `aliasHits` rule as `resolve_alias` — exact, or either-contains when both sides are ≥2 characters — never catalog-wide substring; `issuer_canonical` lists the canonical issuer names the input resolved to. Unknown `tag_id` → empty page plus `unknown_tag_id` |
| `get_card` | `id` | One card, its rate summaries, the term ids those rates cite. Unknown id → `not_found` |
| `get_term` | `id` | One term. Unknown id → `not_found` |
| `list_tags` | `limit?` | Tag id + label |
| `resolve_alias` | `query`, `limit?` | Each hit: the alias text, tag ids, card ids, issuers, networks. DB aliases and the code-side issuer/network maps are merged by alias text. No hit → `matches: []`. Match is normalized (trim, lowercase, collapsed spaces): exact, or either string contains the other when both are at least 2 characters |
| `score_candidates` | `amount_hkd`, `tag_ids?`, `card_ids?`, `alias?`, `merchant?`, `assumptions?`, `as_of?`, `limit?` | One row per matching rate. See §5 |
| `report_issue` | exactly one of `card_id` / `rate_id` / `term_id`, `field`, `claimed_value`, `evidence_url?`, `note?` | `{ ok: true, report_id }`. Writes only to the reports table. There is no public read-back tool |

Failures are `{ ok: false, error, detail? }` plus the same provenance. They are not a thrown stack.

`report_issue` asks for evidence (`evidence_url`) and its description tells callers not to include personal data. It is a suggestion box that feeds the maintenance loop — never a write path to facts ([ADR 0001](adr/0001-product-shape.md)).

Public intake is bounded. `evidence_url`, when present, must be an `http:`/`https:` URL of at most 2048 characters — the admin portal renders it as a link, so other schemes are rejected rather than stored. Free text is capped: `field` ≤ 100, `claimed_value` ≤ 500, `note` ≤ 2000 characters. Volume is capped too: at most 500 reports in a rolling 24-hour window — over the cap is `invalid_report` until triage drains the queue.

## 5. score_candidates

Inputs:

- `amount_hkd` or `amount` — exactly one is required and must be > 0, else `invalid_amount`. `amount_hkd` is already in HKD; `amount` is denominated in `currency` ([ADR 0006](adr/0006-score-currency.md)).
- `currency` — an ISO 4217 three-letter code, normalized to upper case. Absent means the caller asserted nothing about billing currency; the spend is still treated as HKD units. A value that is not three letters → `invalid_currency`. `assumptions.hkd_per_foreign_unit` — HKD per one unit of `currency`; required when `amount` is given with a non-HKD `currency`, else `missing_fx_rate`. The spend converts as `amount × rate`, rounded to cents, before any scoring. `amount_hkd` with a non-HKD `currency` means the caller converted the amount itself.
- `card_ids?` — restricts scoring to those cards. This is the held-set path after the user confirms their wallet; Cardex never learns why the set was chosen. Alias hits contribute their `card_ids` to the same scope.
- Tags come from `tag_ids` and from `alias` (via the same match as `resolve_alias`). No tags at all → `missing_spend`. Resolved tag ids that do not exist are echoed as `unknown_tag_ids` — the call still scores the tags that resolved, and an all-unknown list returns `ok` with empty `candidates`. Same ok-plus-flag contract as `lookup_rates`' `unknown_tag_id`.
- `as_of` — filters windowed terms. Default today.
- `merchant?` — a merchant name to check `merchant_list` whitelists against. Members carry every known name form (en/zh), so the caller passes the name as the user said it. A hit clears the term; a miss keeps it unknown (a fuzzy match can prove membership, never non-membership). The payload echoes `merchant_checked`.
- `assumptions.month_to_date_rebate_hkd` — rebate already earned this period, used only to apply a cap.
- `assumptions.month_to_date_spend_hkd` — eligible spend already made this period, used only to check cumulative `min_spend` gates.
- `assumptions.hkd_per_point` — how the caller values one unit (point or mile) of a `points` rate's `unit`.
- `assumptions.checked_exclusions` — keys the caller asserts do **not** apply. Clears any term by `<kind>:<term id>` (and plain `exclusion_key` for exclusions).

For each matching rate:

| Situation | What the row does |
|---|---|
| `rebate_percent` | `calculated_rebate_hkd = amount × value / 100` |
| `points` and `hkd_per_point` is set | `calculated_rebate_hkd` computed per the rate's `unit` (e.g. `amount × value × hkd_per_point` for `points_per_hkd`; `amount / value × hkd_per_point` for `hkd_per_mile`) |
| `points` and `hkd_per_point` is absent | `calculated_rebate_hkd: null`. `unknown_exclusions` includes `points_value` |
| Cap term, month-to-date **absent** | Do not clamp. `unknown_exclusions` includes `cap_remaining:<term id>` |
| Cap term, month-to-date **present** | Clamp to `max(0, cap_hkd − month_to_date)` |
| `min_spend`, `per_transaction`, amount **below** `threshold_hkd` | `calculated_rebate_hkd: null`. `failed_terms` includes `min_spend_unmet:<term id>` |
| `min_spend`, `per_transaction`, amount meets threshold | Cleared silently |
| `min_spend`, cumulative, `month_to_date_spend_hkd` **absent** | `unknown_exclusions` includes `min_spend:<term id>` |
| `min_spend`, cumulative, spend + amount **below** threshold | `calculated_rebate_hkd: null`. `failed_terms` includes `min_spend_unmet:<term id>` |
| `min_spend`, cumulative, spend + amount meets threshold | Cleared silently |
| `merchant_list`, `merchant` **absent** | `unknown_exclusions` includes `merchant_list:<term id>` |
| `merchant_list`, `merchant` hits a whitelist member | Cleared silently |
| `merchant_list`, `merchant` misses all members | Still `unknown_exclusions` — a miss proves nothing. `merchant_checked` echoes the input |
| `fx_fee`, `currency` explicit `HKD` | Cleared silently — HKD billing cannot trigger the fee |
| `fx_fee`, `currency` absent or non-HKD | `unknown_exclusions` includes `fx_fee:<term id>` — there is no numeric fee field to deduct, so the caller costs it |
| Any other kind not settled | `unknown_exclusions` includes `<kind>:<term id>` |
| Term outside its effective window at `as_of` | Not applied. `unknown_exclusions` includes `term_outside_window:<term id>` |
| Exclusion key **not** in `checked_exclusions` | Leave the number. List the key in `unknown_exclusions` |
| Exclusion key **in** `checked_exclusions` | Treat it as cleared. Do not list it |

Every row echoes `failed_terms` (deterministic failures — distinct from `unknown_exclusions`, which means "the caller must verify"), `exclusive_group`, `priority`, and the rate's `source_url`, `last_verified_at`, and `illustrative`. The payload echoes the effective `amount_hkd`, `currency`, and `fx_rate` (the `hkd_per_foreign_unit` used, or `null`). Rows are ordered by `card_id`, then `rate_id`. There is no `winner`, no rank, and no "best" field. The caller sorts if it wants to.

A cleared exclusion is the caller saying "this does not apply", not Cardex deciding the spend is eligible.

## 6. States

| State | Behaviour |
|---|---|
| No rates match | `ok: true`, `records: []`, `total: 0` |
| Unknown input key on any tool | Protocol `InvalidParams` error — the handler never runs |
| `lookup_rates` with no `tag_id` / `card_ids` / `issuer` | `ok: false`, `error: "missing_filter"` |
| Unknown card or term id | `ok: false`, `error: "not_found"` |
| Unknown tag on lookup | `ok: true`, empty page, `unknown_tag_id` set |
| Unknown tag ids on score | `ok: true`, `unknown_tag_ids` lists them; all-unknown → empty `candidates` |
| Alias matches nothing | `ok: true`, `matches: []` |
| `limit` above 100 | Clamped, `clamped: true` |
| Score with no tag and no usable alias | `ok: false`, `error: "missing_spend"` |
| Score with both or neither of `amount_hkd` / `amount`, or a non-positive amount | `ok: false`, `error: "invalid_amount"` |
| Score `currency` that is not three letters | `ok: false`, `error: "invalid_currency"` |
| Score non-HKD `amount` without `hkd_per_foreign_unit` | `ok: false`, `error: "missing_fx_rate"` |
| Cap or exclusion the caller did not settle | Row still returned. The gap is in `unknown_exclusions` |
| Report accepted | `ok: true`, `report_id`. Lands in quarantine, never in query tables |
| Report missing target, `field`, or `claimed_value` | `ok: false`, `error: "invalid_report"` |
| Report with a non-http(s) `evidence_url` or an over-limit field | `ok: false`, `error: "invalid_report"` |
| Report queue over 500 in 24 h | `ok: false`, `error: "invalid_report"` — try again later |
| Per-IP budget exceeded (any surface) | HTTP `429` before the tool runs — best-effort, per Worker isolate |
| Admin API non-GET from a cross-site caller | HTTP `403` — `Sec-Fetch-Site`/`Origin` must say same-origin |

## 7. Seed Strategy

Current seed is **synthetic**: a handful of cards and rates, every number invented for the shape, every record `illustrative: true`, `source_url` placeholder. Do not cite these figures.

The **cited seed** is the next milestone and follows a different rule: cover the cards most people actually hold — roughly the 15–20 most-held HK cards (the power-law head), not the whole market. Every value carries a real `source_url` and `last_verified_at`. The owner signs off each figure by approving the proposal that carries it ([ADR 0002](adr/0002-maintenance-surface.md)).

`pnpm demo` migrates and seeds local D1, boots `wrangler dev`, and prints payloads from a real MCP client.

## 8. Maintenance Loop

Facts stay true through a loop, not a crawl ([ADR 0002](adr/0002-maintenance-surface.md)):

1. **Triage** — the owner reviews public `report_issue` submissions in `/admin` and independently verifies any leads before assigning work. The maintenance agent (grokbot) may run scheduled checks against issuer sources and work from owner-selected tasks; it cannot read the `reports` quarantine through `/maintainer`.
2. **Propose** — it calls `propose_change` on the `/maintainer` endpoint with evidence: target id, old → new value, `source_url`, excerpt. The proposal lands as a `pending` row carrying structured patches — never raw SQL. Proposal intake is bounded like `report_issue`: `evidence_url` must be `http:`/`https:` (≤ 2048 chars), `summary` ≤ 500 and `excerpt` ≤ 4000 chars, a proposal carries at most 50 patches, and the queue holds at most 100 pending proposals — over the cap is `invalid_proposal` until the owner reviews. Other violations are `invalid_proposal` too. `proposed_by` is recorded as the maintainer credential's identity — the caller's own claim is ignored, so one token can never impersonate another proposer.
3. **Approve** — the owner reviews the proposal in the `/admin` portal and approves or rejects it. The approve is the only write path to facts.
4. **Apply** — on approval the Worker applies the whitelisted patches in a transaction and marks the proposal `applied`.

Until the portal ships, steps 3–4 collapse into the owner applying approved changes with `wrangler d1 execute --remote` — the manual path that exists today.

`report_issue` submissions remain in the admin queue. `/admin/api/reports` serves the portal; `/maintainer` exposes fact reads and `propose_change`, not `list_reports`. The owner may hand a verified task to the agent, but does not forward raw reports as instructions. `skills/cardex-maintainer` is the agent's runbook — a separate artifact from the caller-facing playbook.

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
| **P2** | Cited seed (popular-cards-first), real `database_id` + workers.dev route, playbook content in `skills/cardex`, `skills/cardex-maintainer` + the live maintenance loop — `/maintainer` endpoint, `proposals` table, `/admin` portal, nightly seed export ([ADR 0002](adr/0002-maintenance-surface.md)) |
| **P3** | Rate limiting if abuse shows up, pasteable packaging for non-MCP clients, freshness cadence tuning |

## 11. Out of Scope

A consumer "which card" app, a wallet, a second approver on the portal (one owner, per ADR 0002), auth on the read path, request-time scraping, embedding search, personal data of any kind, and any copy that names a best card.

## 12. Open Questions

Resolved by the [term-kind audit](term-kind-audit.md): the term-kind enum (12 kinds), effective windows on rates, and the `period` vocabulary.

1. The cited-seed card list — which ~15–20 most-held cards? Owner picks; the maintenance agent researches.
2. Does `score_candidates` still ship to real callers only once the cited seed lands?
3. `resolve_alias`: keep exact-or-contains, or tighten short tokens like `red`?
4. Maintenance cadence — weekly or biweekly scheduled passes, and what reactive triggers exist beyond the owner asking?
5. `report_issue` at scale — when does rate limiting move from P3?
6. `unit` vocabulary on rates — a fixed enum or an open string?
7. Watchlist mechanics deferred to `text`: `mission` (nth-transaction rewards), banded/marginal rebate, recurring day-of-month schedules — revisit if the cited seed shows them often.
