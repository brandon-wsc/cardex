# Audit rules — error handling

Working rules for the Jev-based audit gate (warning-only, not a merge
blocker). Draft status: thresholds and scope are tuned by the backtest in
`scripts/audit-backtest.mjs` before the gate goes live.

## Gate flow

```mermaid
flowchart TD
    A[PR diff] --> B[AST 抽出 catch/.catch 候選<br/>連埋 enclosing function]
    B --> C{豁免?}
    C -->|"// audit-allow(ERR-NN)"<br/>或 audit-exempt label| Z[skip]
    C -->|demo.ts / test / scripts| Z
    C -->|無| D{每個候選 × 適用 rule<br/>逐條送 Jev noul}
    D --> E{p ≥ 0.8}
    E -->|yes| F[warning annotation<br/>+ check run: neutral]
    D --> G{0.5 ≤ p < 0.8}
    G -->|yes| H[notice annotation<br/>+ check run: neutral]
    E -->|no| G
    G -->|no| I[冇 finding<br/>check run: success]
    D -.->|API 失敗| J[check run: neutral<br/>audit unavailable]
```

Each catch candidate is classified by the kind of code around it, then
the matching rule's noul question is asked:

```mermaid
flowchart TD
    C[catch / .catch 候選] --> Q{佢喺邊種 code 入面?}
    Q -->|guard/validator<br/>return true = 放行| R2["ERR-02<br/>exception path 係咪<br/>返回『放行』值?"]
    Q -->|一般業務邏輯| R1["ERR-01<br/>失敗時係咪俾咗個<br/>success-shaped 值<br/>畀 caller?"]
    Q -->|任何 catch| R3["ERR-03<br/>error 係咪完全被丟棄?<br/>無 rethrow/無 fallback/<br/>得一句 log"]
    T[test file] --> R4["TEST-01<br/>mock 係咪繞過咗<br/>被測嘅邏輯本身?"]

    R2 -->|true| BAD2[違規: fail-open]
    R1 -->|true| BAD1[違規: 假成功]
    R3 -->|true| BAD3[違規: 黑洞]
```

## How a rule is shaped

Each rule is a single `noul` question — one yes/no judgment with a short
`instructions` line and true/false `criteria`. The question must be
answerable from one function plus its callers. No prose essays: the
backtest showed long rule text degrades Jev's discrimination, so the
wording below is deliberately terse and is what the gate sends verbatim.

## Scope

- Applies to `packages/*/src/**` production code.
- `demo.ts`, scripts, and test files are out of scope — retry and
  cleanup loops there have different semantics.
- Inline exemption: `// audit-allow(ERR-NN): <reason>` on or above the
  handler. PR-wide opt-out: the `audit-exempt` label.

## Rules

### ERR-01 — fake success on failure

- **applies to**: `catch` blocks and `.catch()` callbacks.
- **instructions**: When the operation in the try block or promise
  fails, does the handler hand the caller a value that lets it continue
  as though the operation succeeded?
- **true**: on failure the caller receives a success-shaped result —
  `ok: true`, an applied/created status, a populated object fabricated
  after the failure — and cannot tell the operation failed.
- **false**: the error propagates (rethrow), becomes an explicit error
  result the caller must handle (`fail(...)`, error enum, thrown
  Response), or the fallback is a conservative rejection.

### ERR-02 — permissive default in a guard

- **applies to**: handlers inside validators, auth checks, URL/protocol
  filters, signature or claim verification — any predicate where `true`
  means "allow" / "trust this".
- **instructions**: In a guard that decides whether input is allowed or
  trusted, does the exception path return a permissive verdict?
- **true**: a parse, fetch, or verification failure returns the value
  that treats the input as valid or trusted (`true`, the principal, an
  open decision).
- **false**: the failure returns the denying verdict (`false`, `null`
  the caller turns into a rejection) or propagates as an error. A
  `catch → false/null` in a guard is compliant — that is fail-closed,
  not a swallowed error.

### ERR-03 — error dropped with no substitute

- **applies to**: `catch` blocks whose body has no return, no rethrow,
  no error result, and at most a log line.
- **instructions**: Is the caught error discarded entirely — no rethrow,
  no failure result, no fallback value — so execution continues as if
  the operation never failed?
- **true**: the handler only logs or is empty, and the function goes on
  to return a normal result or nothing, hiding that work did not happen.
- **false**: the handler rethrows, returns an error result, supplies a
  fallback value, or the catch exists to tolerate an already-expected
  failure (best-effort cleanup, a process that may already be dead).

### TEST-01 — mock bypasses the unit under test

- **applies to**: `*.test.ts` / spec files.
- **instructions**: Does the test mock away the very code path it claims
  to verify, so the assertion can pass without the real logic running?
- **true**: the mock replaces or short-circuits the function/module under
  test, or the test asserts only on the mock's own behavior.
- **false**: mocks stand in for external boundaries (network, database,
  clock) while the real unit under test still executes and is what the
  assertion measures.

## Known boundary cases (from the backtest)

These shapes score borderline and guide threshold choice:

- `catch → return false` inside a validator — compliant (ERR-02 false).
- `catch → return null` where every caller maps null to rejection —
  compliant on this codebase; flag when a caller uses the value without
  a null check.
- `.json().catch(() => ({}))` on a request body — borderline: compliant
  only if a later check rejects the missing fields (see
  `handleProposalDecide`, which re-validates `decision`).
- Retry loops and process cleanup that swallow by design — out of
  scope, or exempt inline.
