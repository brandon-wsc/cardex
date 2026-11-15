# List a short tag page

A caller lists tags with a small limit and gets a page of that size, not every tag.

## Sub-features

- `tags-limit` returns at most 3 tags for `limit` 3.
- `tags-page` echoes `limit` and `total`.

## How to get to it (user POV)

- Call `list_tags` on `POST /mcp` with `limit` 3.
- The homepage install prompt tells the caller to try this call.

## Driving it with verify-cardex

Preconditions:

- `verify.sh doctor` succeeded for this run.
- The seed loaded by launch includes tags.

- **Three tags.** Call `list_tags` with `{ "limit": 3 }` using the same client setup as `scripts/drive.ts`. The body is `ok`, `limit` is 3, and `records.length` is the lesser of `total` and 3.
- **Proof.** Write the body to `evidence/<run-id>/list-tags.json`.

## Gotchas

- The homepage prompt text is not itself a tool call. Seeing the prompt does not prove `list_tags`.
- `verify.sh drive` does not call `list_tags`.
