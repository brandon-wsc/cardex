---
name: money-math
description: Exact decimal money arithmetic for Cardex. Use before writing or reviewing code that computes, compares, or rounds money-ish values (hkd, amount, spend, rebate, cap, threshold, fx, value, point…). Run pnpm money-scan to audit the tree; CI runs the same cardex/money-math rule on PR diffs.
---

# Money math — exact decimals only

Cardex reports money (`calculated_rebate_hkd`, `amount_hkd`, caps, thresholds) that callers act on. JS `number` and D1 `REAL` are IEEE-754 doubles — they mis-round `.xx5` midpoints (HK$125.50 × 1% came out 1.25, not 1.26) and mis-judge boundary sums (`0.1 + 0.7 < 0.8` is true in float). [ADR 0011](../../../docs/adr/0011-decimal-scoring.md) locks the contract.

## Rules

1. Money arithmetic lives in `packages/mcp-worker/src/decimal.ts`: `Dec`, an exact BigInt rational. In **strict modules** (`query.ts`, and any file matching `STRICT_FILE` in `scripts/eslint-local-rules.mjs` — add scoring/money modules there) the lint rule asks the TS checker: *every* computed `number`-typed value in `+ - * / %`, computed-vs-computed comparisons, `Math.round/floor/ceil/trunc`, `toFixed`/`toPrecision` is flagged — renaming cannot dodge it. Literal folds and sign checks (`5 - 3`, `x > 0`, `cmp() < 0`) pass; `Dec` is exempt by type. Outside strict modules the rule falls back to names — a money-named identifier (`hkd`, `amount`, `spend`, `rebate`, `cap`, `threshold`, `fx`, `mile`, `cent`, `price`, `cost`, `fee`, `calculated`, `remaining`, `value`, `point`, `rate`) in the same constructs is flagged.
2. `Dec` values carry a `*Dec` suffix (`amountHkdDec`, `remainingDec`) — readable proof of exactness, and what keeps named-mode quiet. `Dec.of(number)` converts at the boundary; `mul`, `div`, `add`, `sub`, `cmp`, `Dec.min`, `Dec.max` accept plain numbers.
3. Round once, at the boundary: `x.round(2).toNumber()` — half-up to cents. Never `Math.round(v * 100) / 100`.
4. Suppression is the escape hatch, not a pattern: `// eslint-disable-next-line cardex/money-math -- <why this is not money>`.

## Audit

```bash
pnpm money-scan                     # whole tree (gate semantics: strict files typed, rest named)
pnpm money-scan --diff origin/dev   # only files changed vs a ref (committed changes)
pnpm money-scan --strict-all        # advisory: typed check on every src file — triage, not a gate
```

The same `cardex/money-math` rule runs inside `pnpm lint`, so a full lint already covers it; `money-scan` is the focused read — for reviewing existing code, checking before commit, or after the rule tightens. `--diff` compares commits; uncommitted work needs the full scan.

`--strict-all` is the wide net for periodic or review-triggered audits: it asks the checker about *every* computed `number` in `packages/*/src`, so unnamed money (a bare `n`, an untyped `any`) cannot hide. Most findings will be counters, timestamps, and comparators — expected. Read each one and decide:

- it touches money → fix via `Dec`, or move the file into `STRICT_FILE` if it owns money logic
- it is recurring noise of one kind (timestamps, `.size`, …) → widen the allowlist in `eslint-local-rules.mjs`
- it is one-off noise → `// eslint-disable-next-line cardex/money-math -- <reason>`

The scan exits 0 either way — the report is for a human/model to classify, not for CI to gate on.

## Reporting a miss

Strict modules cannot miss: the check is on the *type*, not the name. Outside them the rule is name-based by design and errs toward flagging — a false positive costs one disable comment; a missed float bug costs a wrong number on a public endpoint. If a real money value slips through unnamed (a bare `n` parameter), rename it so the rule can see it — or move the file into `STRICT_FILE`.
