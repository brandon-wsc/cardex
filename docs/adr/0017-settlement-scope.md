# ADR 0017 — Settlement scope: billing-currency gates and the cross-border HKD fee

- **Status:** Proposed
- **Date:** 2026-11-20
- **Supersedes:** —

## Context

The 2026-11-20 UAT (real caller against prod) scored a Citi overseas spend billed in HKD and got a gross 2% figure back: the only currency-aware kind was `fx_fee`, which cleared on explicit HKD — correct for the fee, but nothing marked the *rebate* as foreign-currency-only. A caller trusting the number without reading the `geo` term's prose could quote a wrong rebate.

Issuer mechanics (KFS language, verified 2026-11-20) split spend into three settlement classes: HKD at a Hong Kong merchant, HKD at a merchant outside Hong Kong, and a foreign currency. The middle one is its own scheme — Visa/Mastercard charge the issuer ~1% on HKD transactions incurred outside Hong Kong or at merchants not registered in Hong Kong (including online ones), and issuers pass it through (HSBC, DBS, Hang Seng, Fubon all publish the pass-through; some cards are exempt). The term-kind audit already recorded "two fee variants → two `fx_fee` rows" but the schema had no field to tell them apart — and the `fx_fee` code path cleared on explicit HKD, which is exactly wrong for the HKD-scoped variant.

## Decision

1. `score_candidates` gains `merchant_outside_hk?: boolean` — the caller asserts the merchant is located or registered outside Hong Kong. The payload echoes it.
2. New term kind `settlement`: a rate gate on billing currency (e.g. a "Foreign Currency Rebate" requires a non-HKD bill). Explicit `HKD` → deterministic `settlement_unmet:<term id>` in `failed_terms` with `calculated_rebate_hkd: null`; non-HKD → cleared; `currency` absent → `unknown_exclusions`, like every unsettled condition.
3. New term field `ccy_scope` (`non_hkd` | `hkd_outside_hk`) records which billing pattern a currency-scoped term covers. On `fx_fee`: `non_hkd`/unset keeps ADR 0006 semantics; `hkd_outside_hk` prices the cross-border charge and evaluates `currency` × `merchant_outside_hk` — non-HKD bill or in-HK merchant clears it, anything else stays unknown for the caller to cost. Terms still carry no numeric fee field.
4. `geo` stays caller-judged geographic scope (card-present UK/EEA exclusions, "within Hong Kong SAR" gates). Billing currency and merchant location are different facts; `settlement`/`ccy_scope` cover only what `currency` + `merchant_outside_hk` can verify.

## Consequences

- An FCY-gated rate can no longer return a plausible gross figure for an HKD bill — the failure is structural (`failed_terms`), not prose the caller had to read. Red-line grading ("do not quote a `failed_terms` row") already covers it.
- Issuers that count HKD-settled overseas spend toward an "overseas" rate simply carry no `settlement` term — the gate is opt-in per rate, caller judgment is untouched.
- `merchant_outside_hk` is a caller assertion like `merchant`; Cardex never geolocates merchants itself.
- Schema change: `terms` rebuild (0007) — owner review required like every migration.
- The audit's "two `fx_fee` rows" plan is now expressible; per-issuer cross-border fee terms land as ordinary fact proposals, including card-level exemptions (e.g. DBS Live Fresh, UnionPay dual-currency) in their `text`.
