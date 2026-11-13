# Cardex verification map

This directory is the maintained source for verifying Cardex as a caller sees it. Read the index, then use the matching feature file.

## Baseline preconditions

- Launch with `.agents/skills/verify-cardex/scripts/verify.sh launch`.
- The run owns port `8791` unless `CARDEX_VERIFY_PORT` is set, and a private D1 directory under `runs/<run-id>/state`.
- `seed/seed.sql` is loaded. `dining` and `card_hsbc_red` come from that seed.
- Run `verify.sh doctor` and require the recorded pid, state directory, and zh-HK homepage.
- Never drive a Worker this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat commands as literal.
- Homepage checks use `curl` against `GET /` and `GET /en`.
- MCP checks use streamable HTTP at `/mcp` and the arguments in the feature file.
- Do not delete `evidence/<run-id>/` during cleanup.

## Proof and skip reporting

- Capture the request and the resulting body, not only a status code.
- Homepage proof is the HTML containing the hero and the control named in the feature.
- MCP proof is the tool arguments plus the structured body.
- Record the feature id and the entry point in the evidence file.
- Report an unreachable path with the command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly these H2 sections, in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-cardex`, `Gotchas`.

## Features

- [Look up dining rates](./lookup-rates.md) covers a filtered, limited `lookup_rates` call.
- [Read the homepage](./landing.md) covers the zh-HK and English pages and the copy button label.
- [Fetch one card](./get-card.md) covers `get_card` by id.
- [List a short tag page](./list-tags.md) covers `list_tags` with `limit` 3.
