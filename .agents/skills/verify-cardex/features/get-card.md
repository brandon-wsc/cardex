# Fetch one card

A caller who already has a card id fetches that card and does not receive the catalog.

## Sub-features

- `card-by-id` returns `card_hsbc_red` from `get_card`.
- `card-missing` returns a not-found error for an unknown id.

## How to get to it (user POV)

- Call `get_card` on `POST /mcp` with `id` `card_hsbc_red`.
- Call `get_card` with `id` `card_missing`.

## Driving it with verify-cardex

Preconditions:

- `verify.sh doctor` succeeded for this run.
- The seed loaded by launch includes `card_hsbc_red`.

- **Known card.** Call `get_card` with `{ "id": "card_hsbc_red" }` using the same client setup as `scripts/drive.ts`. The body is `ok`, and the card id is `card_hsbc_red`.
- **Missing card.** Call `get_card` with `{ "id": "card_missing" }`. The body is not `ok`.
- **Proof.** Write both bodies to `evidence/<run-id>/get-card.json`.

## Gotchas

- `verify.sh drive` only runs the dining `lookup_rates` recipe. A `get_card` proof is a separate call.
- Do not treat a `lookup_rates` row that mentions the card as a `get_card` proof.
