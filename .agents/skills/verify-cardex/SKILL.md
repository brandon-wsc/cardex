---
name: verify-cardex
description: Drive the local Cardex Worker the way a caller does — homepage over HTTP and MCP tools over streamable HTTP — and capture evidence. Use when a change can affect the public site, /mcp, lookup_rates, get_card, or list_tags, and the proof has to be a real response from a Worker this run started.
---

# Verify Cardex

Prove behavior on a local Worker this run started. Do not attach to an already-running `pnpm dev`, and do not share `packages/mcp-worker/.wrangler`. Two runs need two ports and two `--persist-to` directories.

This checks the local stack (`wrangler dev` plus the built site). It does not open `https://cardex.brandonhk.com`, Cloudflare Access on `/admin`, or remote D1. Those stay unverified.

## Launch

From the repo root:

```bash
.agents/skills/verify-cardex/scripts/verify.sh launch
```

The script builds `packages/site/dist`, applies D1 migrations, loads `seed/seed.sql` into a fresh directory under `.agents/skills/verify-cardex/runs/<run-id>/state`, and starts `wrangler dev` on `127.0.0.1:8791` (override with `CARDEX_VERIFY_PORT`). Ready means `GET /` returns the zh-HK homepage. The printed run id is the one later commands use. Set `CARDEX_VERIFY_RUN_ID` when more than one run exists.

## Doctor

```bash
.agents/skills/verify-cardex/scripts/verify.sh doctor
```

Doctor answers whether this instance is worth driving. It requires the recorded pid to be alive, the state directory to live under that run, `GET /` to contain `碌邊張卡` and the copy button label `複製`, and `GET /mcp` to get a response. It writes `evidence/<run-id>/doctor.json`.

## Drive

Read `features/README.md`, then the feature file. Run one recipe with:

```bash
.agents/skills/verify-cardex/scripts/verify.sh drive
```

`drive` calls `lookup_rates` with `tag_id: "dining"` and `limit: 2` through `@modelcontextprotocol/client` against this run's `/mcp`. It writes `evidence/<run-id>/lookup-rates.json` and exits non-zero when the body is not `ok`, the filter is not dining, `limit` is not 2, the record count exceeds the limit, or `provenance` is missing.

Other features in the map are driven with the same Worker. Use `curl` for the homepage. For `get_card` and `list_tags`, repeat the `drive.ts` call shape with those tool arguments and write a separate evidence file. Do not report a feature verified through a different entry point.

## Evidence

Proof is the request and the resulting tool body or HTML, stored in `.agents/skills/verify-cardex/evidence/<run-id>/`. Capture the action and the returned state. A homepage proof shows the hero text and the `複製` button in the HTML; it does not prove the clipboard write. An MCP proof shows the arguments and the structured body, including `records.length`, `limit`, and `total`.

## Cleanup

```bash
.agents/skills/verify-cardex/scripts/verify.sh cleanup
```

Cleanup kills the pid this run recorded, then its child processes, and deletes that run's `state` directory. It leaves `evidence/<run-id>/` in place. After cleanup, confirm the evidence files are still there. Never kill a process by name.

## Helpers

`scripts/verify.sh` is the only entry point. `scripts/drive.ts` is the MCP call it runs via `pnpm --dir packages/mcp-worker exec tsx`.

When the app changes and this map was not updated with it, run `/maintain-verification-skill`.
