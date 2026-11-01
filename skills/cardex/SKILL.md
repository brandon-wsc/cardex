---
name: cardex
description: Query the Cardex remote MCP for Hong Kong credit-card rebate facts — rates, caps, exclusions, spend tags, merchant aliases, and promo conditions. Use when an agent needs to look up what a HK credit card earns on a spend, check a cap or exclusion, verify whether a promo applies, or report a stale figure. Facts only — Cardex never names a best card.
---

# Cardex

Remote MCP of structured Hong Kong credit-card facts. You connect, ask narrow questions, and do your own ranking. Cardex returns records; it never recommends a card — **you** own the judgment and the user conversation.

## Connect

- **Endpoint:** `POST {BASE_URL}/mcp` — streamable HTTP transport, stateless, no auth.
- **Local dev:** `http://localhost:8787/mcp` after `pnpm migrate && pnpm seed && pnpm dev` in the cardex repo.
- **Hosted:** `https://cardex.brandonhk.com/mcp` (custom domain; workers.dev is disabled).

Example client config:

```json
{ "mcpServers": { "cardex": { "url": "https://cardex.brandonhk.com/mcp" } } }
```

### No MCP client?

The endpoint is plain HTTP — if you can POST, you can call it. Stateless: a single request is a complete call, no `initialize` handshake.

```bash
curl {BASE_URL}/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_tags","arguments":{"limit":3}}}'
```

Both `accept` entries are required. The response is a single SSE frame: take the `data:` line, `JSON.parse` it, and read `result.structuredContent` (the `content[0].text` echo carries the same payload). Swap `tools/call` for `tools/list` to discover schemas. CORS is open, so a browser `fetch` works too.

## Tools

Every list tool takes filters and `limit` (default 5, max 100 — higher is clamped and the payload echoes `limit_requested` + `clamped`). Every filter takes `as_of` (default: today, `YYYY-MM-DD`); records outside their effective window are dropped from lists and scores but stay fetchable by `id`. Follow up with `get_card` / `get_term` by `id`; tools never return the whole catalog. Each payload echoes `seed_as_of` — the date the underlying data was last refreshed.

| Tool | Call it when | Key args |
| --- | --- | --- |
| `resolve_alias` | You have a merchant name, nickname, or free text (`茶餐廳`, `hsbc red`, `淘寶`) and need tag or card ids | `query`, `limit` |
| `lookup_rates` | You need the rates for a tag, set of cards, or issuer | `tag_id`, `card_ids`, `issuer`, `as_of`, `limit` |
| `get_card` | You need one card's details and its rate summaries | `id` |
| `get_term` | A rate cites `term_ids` you cannot evaluate | `id` |
| `list_tags` | You need the canonical spend tags | `limit` |
| `score_candidates` | You want the rebate math for a spend under your own assumptions | `amount_hkd`, `tag_ids`, `card_ids`, `alias`, `merchant`, `assumptions`, `as_of`, `limit` |
| `report_issue` | The user (or you) believes a fact is wrong or stale | one of `card_id`/`rate_id`/`term_id`, `field`, `claimed_value`, `evidence_url`, `note` |

Typical flow: `resolve_alias` the spend → `lookup_rates` (scoped to the user's confirmed `card_ids` if comparing held cards) → `get_term` any `term_ids` you can't check → `score_candidates` with explicit `assumptions`.

## Suggest, then confirm the wallet

Cardex never learns which cards the user holds — there is no wallet endpoint.

1. To **compare held cards**: ask the user which cards they have, map each name through `resolve_alias`, and confirm any ambiguous hit (below). Then pass the confirmed ids as `card_ids` to `lookup_rates` / `score_candidates`.
2. To **suggest cards they don't hold**: call without `card_ids`, rank the results yourself, and present candidates. A suggestion is not a claim the user owns the card — phrase it as "cards that earn well here include…".

Never infer holdings from alias hits alone.

## Reading a score row

Each `score_candidates` row has three lists-worth of signals. Read all of them before quoting a number:

- `calculated_rebate_hkd` — the math, or `null`. Null is not "zero"; check why.
- `failed_terms` — **dead** conditions: the spend deterministically fails (e.g. `min_spend_unmet:<term id>`). Do not present that rate as available. Distinct from unknowns — failed means settled-and-false.
- `unknown_exclusions` — conditions Cardex **cannot verify**: `<kind>:<term id>` entries, `cap_remaining:<id>`, `points_value`, `term_outside_window:<id>`. These mean "verify before you quote," not "the rate fails."
- `exclusive_group` + `priority` — rows sharing an `exclusive_group` cannot stack. Keep the best `priority` per group before ranking; do not add competing rates together.
- `merchant_checked` — echoes the `merchant` you passed, so the user can see what was checked.

## Settling terms

`assumptions.checked_exclusions` clears a term by its `exclusion_key` or by `<kind>:<term id>`. Every other kind needs a different input — the kind tells you what to check:

| Kind | What it is | What settles it |
| --- | --- | --- |
| `cap` | Rebate ceiling per period | `month_to_date_rebate_hkd` — Cardex clamps automatically when provided |
| `min_spend` | Spend floor before the rate applies | Per-transaction floors auto-check against `amount_hkd` (fail → `min_spend_unmet`). Cumulative floors need `month_to_date_spend_hkd`; without it the term stays unknown |
| `merchant_list` | Named-merchant whitelist | Pass `merchant`. A hit clears it; **a miss keeps it unknown** — fuzzy matching can prove membership, never non-membership. Check `merchant_checked` and consider asking the user for the receipt name |
| `exclusion` | A condition that kills the rate | `checked_exclusions` with the `exclusion_key` — only when the user confirms it does not apply |
| `fx_fee` | Foreign-currency fee | `checked_exclusions` with `fx_fee:<term id>` to settle, or net the fee from the rebate yourself |
| `registration_required` | Opt-in / promo code needed | Ask the user if they registered; settle via `checked_exclusions` |
| `channel` / `mcc` | Booking channel / merchant category | You judge from the spend context and the term `text` |
| `quota` | First-N registrants (FCFS) | Cannot be verified — quota usage is not public. Warn the user it may be full |
| `geo` | Issuer's "overseas" definition | Definitions differ per issuer — read the term `text`/`source_url`, don't assume |
| `targeted` | Selected-cardholders-only promo | Ask the user whether they received the invite |
| `eligibility` | Who may hold/get the rate (principal-only, new-customer, account gate) | Check against what you know about the user |

A term stays in `unknown_exclusions` until you settle it. Quoting a number with unresolved unknowns is fine — quoting it *without mentioning* them is not.

## Resolving names

`resolve_alias` returns every hit as a list — it never picks for you.

- **Confirm card hits with the user.** A card id from an alias is a candidate, not an identification — unless the user's words match the alias text exactly. "My HSBC card" resolving to `hsbc red` does not mean they hold the Red card; ask which card they mean.
- **Issuer-only queries are ambiguous by nature.** If the query is an issuer name and hits land on a specific card, treat the hits as suggestions to confirm, not answers.
- **Multiple hits are good news,** not noise — they expose the ambiguity. Offer them to the user rather than choosing one.
- **`matches: []` means Cardex does not know the name.** Fall back to asking the user for a spend description or the card's full name; do not guess a tag.

## Reporting a bad fact

`report_issue` writes to a quarantine table that feeds the maintenance loop — it never mutates facts directly. File it when the user spots a wrong figure or you find fresher issuer terms. Always include `evidence_url` (the issuer page). Never put personal data in `note`.

## Contract

- **Facts only.** No `winner`, no ranking, no best-card language. `score_candidates` echoes `assumptions_used` — check it before quoting a number.
- **`provenance.illustrative: true`.** Until the cited seed lands, every figure is invented. Do not present a Cardex number as an issuer's real terms; confirm with the issuer.
- **Freshness.** Terms carry `source_url`, `last_verified_at`, `effective_from`/`effective_to`. An old `last_verified_at` or a promo `as_of` past `effective_to` means treat the fact as stale.
- **Not found is a payload,** not an exception: `{ "ok": false, "error": "not_found" }`. Same for `invalid_date`, `invalid_limit`, `invalid_amount`, and `missing_spend`.
