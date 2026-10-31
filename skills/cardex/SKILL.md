---
name: cardex
description: Query the Cardex remote MCP for Hong Kong credit-card rebate facts — rates, caps, exclusions, spend tags, and merchant-name aliases. Use when an agent needs to look up what a HK credit card earns on a spend, check a cap or exclusion, or resolve a merchant name to a spend category. Facts only — Cardex never names a best card.
---

# Cardex

Remote MCP of structured Hong Kong credit-card facts. You connect, ask narrow questions, and do your own ranking. Cardex returns records; it never recommends a card.

## Connect

- **Endpoint:** `POST {BASE_URL}/mcp` — streamable HTTP transport.
- **Local dev:** `http://localhost:8787/mcp` after `pnpm migrate && pnpm seed && pnpm dev` in the cardex repo.
- **Hosted:** use the `workers.dev` URL the repo owner publishes; there is no auth on the prototype endpoint.

Example client config:

```json
{ "mcpServers": { "cardex": { "url": "https://cardex.<account>.workers.dev/mcp" } } }
```

## Tools

Every list tool takes filters and `limit` (default 5, max 20 — higher is clamped). Follow up with `get_card` / `get_term` by `id`; tools never return the whole catalog.

| Tool | Call it when | Key args |
| --- | --- | --- |
| `resolve_alias` | You have a merchant name, nickname, or free text (`茶餐廳`, `hsbc red`, `淘寶`) and need tag or card ids | `query`, `limit` |
| `lookup_rates` | You need the rates for a tag, card, or issuer | `tag_id`, `card_id`, `issuer`, `limit` |
| `get_card` | You need one card's details and its rate summaries | `id` |
| `get_term` | A rate cites `term_ids` you cannot evaluate | `id` |
| `list_tags` | You need the canonical spend tags | `limit` |
| `score_candidates` | You want the rebate math for a spend under your own assumptions | `amount_hkd`, `tag_ids`, `alias`, `assumptions`, `limit` |

Typical flow: `resolve_alias` the spend → `lookup_rates` the tag → `get_term` any `term_ids` you can't check → optionally `score_candidates` with explicit `assumptions`.

## Example calls

```json
{ "name": "resolve_alias", "arguments": { "query": "茶餐廳" } }
{ "name": "lookup_rates", "arguments": { "tag_id": "dining", "limit": 10 } }
{ "name": "get_term", "arguments": { "id": "term_hsbc_dining_cap" } }
{
  "name": "score_candidates",
  "arguments": {
    "amount_hkd": 800,
    "alias": "茶餐廳",
    "assumptions": {
      "month_to_date_rebate_hkd": 250,
      "hkd_per_point": 0.05,
      "checked_exclusions": ["octopus_topup"]
    }
  }
}
```

## Resolving names

`resolve_alias` returns every hit as a list — it never picks for you.

- **Confirm card hits with the user.** A card id from an alias is a candidate, not an identification — unless the user's words match the alias text exactly. "My HSBC card" resolving to `hsbc red` does not mean they hold the Red card; ask which card they mean.
- **Issuer-only queries are ambiguous by nature.** If the query is an issuer name and hits land on a specific card, treat the hits as suggestions to confirm, not answers.
- **Multiple hits are good news,** not noise — they expose the ambiguity. Offer them to the user rather than choosing one.
- **`matches: []` means Cardex does not know the name.** Fall back to asking the user for a spend description or the card's full name; do not guess a tag.

## Contract

- **Facts only.** No `winner`, no ranking, no best-card language. `score_candidates` echoes `assumptions_used` and lists `unknown_exclusions` — terms it could not check. Read those before quoting a number.
- **`provenance.illustrative: true`.** Every number in the seed is invented. Do not present a Cardex figure as an issuer's real terms; confirm with the issuer.
- **Term freshness.** `get_term` returns `text`, `source_url`, and `effective_from`/`effective_to`. Check dates before relying on a term.
- **Not found is a payload,** not an exception: `{ "ok": false, "error": "not_found" }`. Same for `invalid_limit`, `invalid_amount`, and `missing_spend`.
