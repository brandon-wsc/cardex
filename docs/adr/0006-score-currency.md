# ADR 0006 — Currency-aware scoring input

- **Status:** Accepted
- **Date:** 2026-11-01
- **Supersedes:** —

## Context

`score_candidates` took only `amount_hkd`. Real spends are billed in USD, EUR, JPY — so callers had to convert before calling, with the conversion rate invisible to the payload. And `fx_fee` terms always sat in `unknown_exclusions`, even for spends the caller knew were HKD-billed where no fee could possibly trigger.

## Decision

1. `amount` + `currency` join `amount_hkd` as an alternative spend input; exactly one of `amount_hkd` / `amount` is required. `currency` is an ISO 4217 three-letter code.
2. For a non-HKD `amount`, `assumptions.hkd_per_foreign_unit` converts to HKD before scoring (rounded to cents); absent → `missing_fx_rate`. `amount_hkd` with a non-HKD `currency` means the caller converted — still valid, and the currency still informs `fx_fee` relevance.
3. `fx_fee` settles on the caller's currency assertion: explicit `HKD` → cleared silently (the fee cannot trigger); absent or non-HKD → stays in `unknown_exclusions`. Terms carry no numeric fee field, so Cardex cannot deduct it — the caller costs it.
4. The payload echoes the effective `amount_hkd`, `currency`, and `fx_rate`, so the conversion assumption is visible, not implied.

## Consequences

- No schema change: the conversion rate is caller-declared. Cardex never picks an FX rate — quoting one would be a fact with a timestamp, and facts come from the seed, not request-time logic.
- An absent `currency` stays conservative: `fx_fee` keeps surfacing as unknown rather than silently clearing on an assumed HKD bill. Clearing is opt-in via an explicit `HKD`.
- A future numeric fee field on `fx_fee` terms could upgrade the non-HKD case to a real deduction with no input change.
