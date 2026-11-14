# ADR 0011 — Exact decimal scoring

- **Status:** Accepted
- **Date:** 2026-11-14
- **Supersedes:** —

## Context

Every money path in `score_candidates` ran on IEEE-754 doubles — the only `number` type JS/TS and D1 `REAL` have. Three concrete failure modes shipped:

- `Math.round(v * 100) / 100` drops a cent on `.xx5` midpoints: HK$125.50 at 1% is exactly 1.255, but the binary value is 1.2549999…, so the tool reported 1.25.
- Threshold gates compare binary sums: `0.1 + 0.7 < 0.8` is `true` in float, so a cumulative `min_spend` the spend actually meets could fail and null the row — a cliff, not a cent.
- `cap_hkd − month_to_date` inherits the same representation noise before `Math.min` clamps it.

Integer cents do not fix this: `rebate_percent` values like 0.4, `hkd_per_point` valuations, and `hkd_per_mile` divisors (HK$3 = 1 mile is non-terminating) are not cent quantities. A wrong number also ships silently in `calculated_rebate_hkd` — nothing in the loop reviews it.

## Decision

1. `packages/mcp-worker/src/decimal.ts` holds the only money arithmetic: `Dec`, an exact rational over `BigInt`. `Dec.of(number)` recovers the decimal the caller typed via its shortest round-trip string — never the binary expansion. All intermediate math (multiply, divide, add, subtract, compare) is exact.
2. Money leaves `Dec` exactly once per value: reported figures (`calculated_rebate_hkd`, the echoed `amount_hkd`) round **half-up to cents** at the boundary. Threshold and cap comparisons happen inside `Dec`, never on floats.
3. Non-finite numeric input (`NaN`, `Infinity`) in the spend or `assumptions` is `invalid_amount`; a non-finite `hkd_per_foreign_unit` is `missing_fx_rate`, the same bucket as a non-positive one.
4. Storage and wire stay `REAL` / JSON `number` — the decimal is recovered exactly from every finite double, so no schema or payload change is needed.
5. Prevention is mechanized, not convention: the `cardex/money-math` ESLint rule runs in two modes. In money modules (`STRICT_FILE` in `scripts/eslint-local-rules.mjs` — `query.ts` today) the rule is **type-checked**: every computed `number`-typed operand in arithmetic (`+ - * / %`), computed-vs-computed comparisons (`< <= > >=`), or `Math.round/floor/ceil/trunc` / `toFixed` / `toPrecision` is flagged, so unnamed money cannot slip through; `Dec` is exempt by type, literal folds and sign checks (`x > 0`, `cmp() < 0`) pass. Elsewhere it is **name-checked**: money-named identifiers in the same constructs are flagged, and `*Dec` names stay exempt. `pnpm money-scan` runs the rule alone — full tree locally, `--diff <ref>` on PRs in CI, `--strict-all` as an advisory typed check over every src file for periodic audits (findings are triaged by the reviewer, never gated). Suppression is `// eslint-disable-next-line cardex/money-math` with a reason, reviewed in the PR.

## Consequences

- Caller-visible change only on boundaries the old code already got wrong (1.255 now reports 1.26, not 1.25). No payload shape change.
- `decimal.ts` is the single file where raw numbers may touch arithmetic — one place to audit.
- Outside strict modules the lint rule is name-based and errs toward flagging: a false positive costs one disable comment; a missed float bug costs a wrong number on a public endpoint. A repo-wide "flag all number arithmetic" variant was tried — 13/13 false positives (timestamps, counters, comparators), so type-checking stays scoped to money modules.
- Domain rounding stays out of scope: per-transaction truncation and issuer-specific rounding clauses live in `term.text` ([term-kind-audit](../term-kind-audit.md) #29). `calculated_rebate_hkd` is a normalized estimate, not a statement replica.
