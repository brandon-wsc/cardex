# ADR 0013 — Money-math scan is advisory, not a merge gate

- **Status:** Accepted
- **Date:** 2026-11-15
- **Amends:** [ADR 0011](0011-decimal-scoring.md) §5 — enforcement posture only; the `Dec` design stands
- **Supersedes:** —

## Context

ADR 0011 mechanized float-money prevention in two places: `cardex/money-math` runs as an `error` inside `pnpm lint`, and a `money-scan --diff` step plus the rule's regression suite sit inside the required `eslint complexity gate` job on every PR.

The rule is a heuristic, not a proof. Outside `STRICT_FILE` modules it is name-checked — it flags money-*named* identifiers in arithmetic — and ADR 0011's own data point (a repo-wide typed variant scored 13/13 false positives) is why strict typing stays scoped to money modules. A heuristic that gates merges produces the failure ADR 0010 designed around: false positives train reviewers to ignore a red gate, and the signal is lost either way — dismissed inside a blocking job, or suppressed to get green.

## Decision

The money-math check leaves the merge path and reports on its own:

1. `cardex/money-math` runs as `warn` in `pnpm lint` — still visible locally, in editor squiggles, and in lint output; it gates nothing.
2. A separate `pull_request` workflow, `money-scan.yml` (check name `money-math scan (advisory)`), runs `money-scan --diff <base>` and `pnpm test:money-rule` and reports an honest pass/fail. It is not a branch-protection required context, so findings turn the check red without blocking merge — the reviewer triages, the same contract the audit gate runs under (ADR 0010).
3. `money-scan`'s own config keeps the rule at `error`, so the scan's exit code still reflects findings; `--strict-all` stays a manual, never-gated audit.

## Consequences

- A money-math finding no longer blocks a PR — including the type-checked strict mode on money modules, whose false-positive rate is near zero. Splitting severity by file would leave part of the check gating, which is the thing being removed; re-tightening strict files is a one-line severity change in `eslint.config.mjs` plus restoring the steps.
- Findings stay visible: the advisory check goes red on the PR and `pnpm money-scan` still exits non-zero locally. Suppression with a reason (`// eslint-disable-next-line cardex/money-math`) remains the reviewed escape hatch.
- The required `eslint complexity gate` job goes back to being only the eslint gate its name describes.
