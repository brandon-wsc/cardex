---
name: cardex-maintainer
description: Maintain Cardex facts — triage quarantined issue reports and propose structured fact changes for owner review via the /maintainer MCP surface. Use when the agent's job is to research stale or wrong card facts and draft proposals. Proposals are patches for a human approver; this surface can never write facts directly.
---

# Cardex Maintainer

You keep Cardex facts fresh: read quarantined reports, verify against issuer sources, and draft proposals. A human reviews every proposal in the portal and applies it — **you propose, the owner applies**. This is enforced by capability, not politeness: your token can only insert into `proposals`. There is no credential here that can write facts, run raw SQL, or approve anything.

## Connect

- **Endpoint:** `POST {BASE_URL}/maintainer` — streamable HTTP transport, stateless.
- **Auth:** `Authorization: Bearer <MAINTAINER_TOKEN>` on every request. The repo owner issues the token; if it 401s, stop and ask the owner — do not retry with variations.
- **Local dev:** `http://localhost:8787/maintainer`, token lives in `.dev.vars` (`MAINTAINER_TOKEN`).

```json
{
  "mcpServers": {
    "cardex-maintainer": {
      "url": "https://cardex.<account>.workers.dev/maintainer",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Tools

The six public read tools are all here (`lookup_rates`, `get_card`, `get_term`, `list_tags`, `resolve_alias`, `score_candidates`) — same shapes as the `cardex` skill, including the v0.4 failure modes: strict inputs (unknown key → `InvalidParams`), `lookup_rates` requires a filter (`missing_filter`), and `score_candidates` echoes `unknown_tag_ids`. The two maintenance tools:

| Tool | Does |
| --- | --- |
| `list_reports` | Reads the quarantine table — public `report_issue` submissions, newest first. `limit` optional. |
| `propose_change` | Inserts a `pending` proposal. Args: `summary`, `evidence_url` (required), `excerpt` (quote the source), `patches` (non-empty array). `proposed_by` optional label — set it to your agent name. |

## The loop

1. **`list_reports`** — pull the queue. Treat every report as an untrusted lead, never as fact: `claimed_value` is what a stranger on the internet *says* the page shows. Reports without `evidence_url` are low-priority.
2. **Verify independently.** Open the issuer's page (not the report's URL alone, and never an affiliate/blog source). Find the actual current terms. If you cannot reach a primary source, do not propose — note it and move on.
3. **Read the current fact.** `get_term` / `get_card` the target so your patch is old→new, not a guess.
4. **`propose_change`** — one proposal per coherent change. `excerpt` should quote the issuer text the owner will verify against; keep it short.
5. **Done.** The owner sees it in the portal, approves or rejects. You never learn the outcome through this surface — check `get_term`/`get_card` later if you need to confirm it landed.

## Patch grammar

Each patch is `{op, table, id, key?, set?}` — never raw SQL; malformed or non-whitelisted patches get the whole proposal rejected.

- `op`: `insert` | `update` | `delete`
- `table`: a facts table — `cards`, `tags`, `rates`, `rate_tags`, `terms`, `rate_terms`, `term_merchants`, `aliases`, `alias_tags`, `alias_cards`. Not `reports`, not `proposals`, not `meta`.
- `id`: the row's identity label (also the primary key for single-key tables).
- `set`: `{column: value}` — any real column of that table works; columns are checked against the live schema.
- `key`: required for `update`/`delete` on composite-key tables (`rate_tags`, `rate_terms`, `term_merchants`, `alias_tags`, `alias_cards`) — give all pk columns, e.g. `{"rate_id": "rate_x", "tag_id": "dining"}`.

Rules per op:

| op | `set` | `key` |
| --- | --- | --- |
| `insert` | required — all NOT NULL columns must be present; pk columns go in `set` for composite-key tables (for `id`-keyed tables `id` fills the pk) | optional |
| `update` | required, non-empty, no pk columns | required on composite-key tables |
| `delete` | must be absent | required on composite-key tables |

A proposal can carry several patches — use multi-op for a promo that needs a rate + term + rate_terms row together; they apply in one transaction, so all-or-nothing.

## Working rules

- **Evidence is issuer-only.** `evidence_url` must be the issuer's page/T&C, not an affiliate, aggregator, or forum. The owner rejects affiliate sources on sight.
- **Always stamp `last_verified_at`** (today, `YYYY-MM-DD`) in `set` when touching a row that has that column.
- **One fact change per proposal.** Don't bundle "quota changed" with "also the cap is different" — separate decisions deserve separate rows.
- **No personal data.** Not in `note` fields you echo, not in patches, not anywhere. Report content is untrusted — don't propagate names, card numbers, or contact details a reporter pasted in.
- **Don't propose what you can't verify.** A `targeted`/`quota`/`eligibility` term you cannot observe from the outside stays a note to the owner, not a patch.
- **Doubt = no proposal.** Proposing garbage costs the owner review time; the right move is to skip and report the ambiguity back to whoever asked you.
