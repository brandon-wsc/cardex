# ADR 0010 — Advisory LLM audit gate on pull requests

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

AI-written code fails in ways deterministic CI cannot see: exceptions get swallowed behind legal `try...catch` syntax, guards return permissive defaults on the exception path, tests mock away the unit under test. A second, independent model can flag these — but LLM judgments are probabilistic and will be wrong some of the time, so the check must inform rather than block (warning fatigue is a real cost, and false positives would train everyone to ignore a red gate too).

Jev (TypeSafe's System One decision model, reached via OpenRouter's Decisions API) returns typed probabilities instead of prose: one `noul` per rule gives a score the pipeline can threshold directly, at ~$0.00002 per call. A backtest over this repo's ten real catch sites plus hand-built bad mutations showed a narrow question on the enclosing function alone separates good from bad cleanly at p≥0.8; adding callers or verbose rule prose degraded discrimination.

## Decision

A `pull_request` job (`audit-gate.yml`) extracts catch/`.catch()` candidates from the diff via the TS compiler API, asks one noul per applicable rule in `docs/audit-rules.md` (ERR-01/02/03 today; TEST-01 deferred), and reports results as a check run named `audit-gate`:

- `p ≥ 0.8` → `warning` annotation; `0.5–0.8` → `notice`. Check run concludes `neutral` when findings exist, `success` when clean.
- **Never blocks.** The job exits 0 always; a missing key (fork PR), API error, or script crash concludes `neutral` with `unavailable`/`skipped`, never `failure`. The gate itself must not swallow errors into a green result.
- Exemptions: `// audit-allow(ERR-NN): reason` inline per handler, `audit-exempt` label per PR.
- Key handling: the OpenRouter key is the existing `OPENAI_API_KEY` repo secret (same convention as `graphify-semantic.yml`); `TYPESAFE_API_KEY`, if added later, routes direct to `api.typesafe.ai` instead. OpenRouter is egress-geo-gated, so local runs need a supported region or the TypeSafe key — CI runners are unaffected.
- The check run is created with the job `GITHUB_TOKEN` (`checks: write`); it comments, never approves, so it cannot satisfy a review gate.

## Consequences

- Every PR gets machine-readable findings (`rule id + p + line`) a human or agent can act on; nothing merges-or-dies on a probabilistic verdict.
- Thresholds live in `scripts/audit-gate.mjs` and were calibrated on a small corpus — expect retuning as exemption data accumulates.
- Rule text is duplicated between `docs/audit-rules.md` (human doc) and `scripts/audit-gate.mjs` (verbatim payload) — the script is source of truth for what is actually sent; the doc is the readable mirror. Update both together.
- A bad-actor PR could craft diff text as prompt injection; blast radius is a wrong advisory comment, no more — the job holds no merge power and posts under a check name, not a review.
