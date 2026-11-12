# Look up dining rates

A caller asks for rates tagged dining and receives one limited page, with the filter and provenance echoed back.

## Sub-features

- `rates-dining` returns dining rates for `tag_id` `dining`.
- `rates-limit` returns at most the requested `limit` records.
- `rates-echo` echoes `filters.tag_id`, `limit`, `total`, and `provenance`.

## How to get to it (user POV)

- Call the `lookup_rates` tool on `POST /mcp` with `tag_id` `dining` and `limit` 2.

## Driving it with verify-cardex

Preconditions:

- `verify.sh doctor` has written `evidence/<run-id>/doctor.json` for this run.
- The private D1 was seeded from `seed/seed.sql`.

- **Dining page.** Call `lookup_rates`. Run `.agents/skills/verify-cardex/scripts/verify.sh drive`. The evidence file `evidence/<run-id>/lookup-rates.json` has `observed.ok` true, `observed.tag_id` `dining`, `observed.limit` 2, and `observed.recordCount` equal to the lesser of `total` and 2.
- **Proof.** The same file is the proof. It stores the arguments and the structured body.

## Gotchas

- A call with no `tag_id`, `card_ids`, or `issuer` returns `missing_filter` and is not this feature.
- `limit` larger than the tool maximum is clamped. This recipe uses 2 so the page stays inside the cap.
- Driving `GET /mcp` without the MCP client does not perform a tool call.
