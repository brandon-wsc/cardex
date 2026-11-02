# ADR 0005 — Per-record provenance, computed envelope

- **Status:** Accepted
- **Date:** 2026-11-01
- **Supersedes:** —

## Context

Every payload carried the same hard-coded envelope — `provenance.kind: "synthetic-seed"`, `illustrative: true` — and rate rows did not return their `source_url` / `last_verified_at` at all, even though both columns exist on `rates` and `terms`. That was tolerable while the whole seed was invented, but the cited seed lands record by record through the propose → approve → apply loop ([ADR 0002](0002-maintenance-surface.md)). The dataset will be mixed for a long time, and a global flag is either always-false (a lie) or always-true (it tells the caller nothing about which row to trust).

## Decision

1. `illustrative` is a per-record property. A rate or term is **verified** when `source_url` is a real URL — anything but the seed placeholder host `example.invalid` — and `last_verified_at` is set. Everything else is `illustrative: true`.
2. `lookup_rates`, `get_card`, and `score_candidates` rows echo `source_url`, `last_verified_at`, and `illustrative`; `get_term` adds `illustrative` to the returned term record.
3. The envelope `provenance` summarizes the fact records the payload returned: `cited-seed` (`illustrative: false`) when all are verified, `mixed-seed` (`illustrative: true`) when some are, and `synthetic-seed` (`illustrative: true`) when all are — or when the payload carries no fact records (errors, empty pages, tag and alias lists, report acknowledgements).
4. No `verified` column is added to the schema: verification is derived from the two existing evidence columns, so a record becomes cited by carrying a real source and a check date, not by a separate flag an approver could forget to set.

## Consequences

- A caller can cite or discount per row instead of treating the whole catalog as fake or real.
- During the cited-seed transition the envelope honestly reads `mixed-seed`.
- The rule rests on one convention: real facts never carry an `example.invalid` source URL. Proposal review and `scripts/export-seed.sh` keep that true; a placeholder URL anywhere is fabrication by definition.
- The envelope summarizes the returned page, not the whole match set — a caller paging past `limit` re-evaluates provenance per page.
