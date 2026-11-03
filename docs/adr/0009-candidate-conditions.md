# ADR 0009 — Per-condition status on score rows

- **Status:** Accepted
- **Date:** 2026-11-03
- **Supersedes:** —

## Context

`score_candidates` rows carried only `unknown_exclusions` and `failed_terms`. Every other evaluation outcome hit a bare `continue`: a verified gate (min_spend met, merchant whitelisted, `fx_fee` inapplicable to an HKD bill) and a term the caller settled via `checked_exclusions` left no trace on the row. A rate could therefore surface an attractive `calculated_rebate_hkd` with four unverified gates, and the caller could not distinguish "passed all checks" from "nothing was verified" without diffing `term_ids` by hand. Worse, a mistyped `checked_exclusions` key — one that matched no term anywhere — was silently ignored, so a caller could believe a gate was settled when nothing consumed the assertion.

## Decision

1. Each scored row carries `conditions`: one entry per term the rate cites, in `term_ids` order — `{ term_id, kind, key, status }`. `key` is the `checked_exclusions` token that settles the condition (`<kind>:<term id>`, or the `exclusion_key` for exclusions).
2. `status` is one of:
   - `passed` — the tool verified the condition is satisfied (min_spend met, merchant_list hit, fx_fee cleared by explicit HKD currency).
   - `applied` — the tool evaluated the condition and adjusted the number (a cap clamped `calculated_rebate_hkd`).
   - `failed` — the tool verified the condition is **not** satisfied (`min_spend_unmet`).
   - `unchecked` — the tool cannot verify it; the caller must (cap without month-to-date, merchant miss, and every kind with no checkable input).
   - `caller_settled` — cleared by a matching `checked_exclusions` entry.
   - `outside_window` — the term is inactive at `as_of` and was not applied.
3. The envelope gains `unmatched_checked_exclusions`: asserted keys that matched no term on any scored rate — the typo/stale-id signal. Omitted when every asserted key was consumed.
4. `unknown_exclusions` and `failed_terms` keep their existing shapes; `conditions` is additive, not a replacement.

## Consequences

- Every term on a scored rate has a visible status — nothing silently drops. A caller can now read "8% = HK$472.99, 4 gates unchecked" without reconstructing the audit trail.
- `caller_settled` stays honest: it records an assertion, not a verification — the caller said "does not apply", Cardex did not decide it ([ADR 0001](0001-product-shape.md)).
- `unmatched_checked_exclusions` only measures the scored page — a key settling a term on a rate cut by `limit` reports as unmatched for that response.
- Facts-only is preserved: `calculated_rebate_hkd` still shows the computed number with its caveats; Cardex does not withhold or re-judge it.
