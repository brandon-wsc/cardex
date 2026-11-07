# Execution conventions

Commits, branches, pull requests, and feature-work flow. Pointed to by the root `AGENTS.md` — read it before committing, branching, or opening a PR. This file is the single copy; do not duplicate it in harness-specific packs (`.cursor/rules`, `CLAUDE.md`, and similar).

## Feature work

- **Do not commit to, merge into, or push `main`.** Work on a feature branch. The repo owner updates `main` and handles PRs.
- **New feature / fix → fresh branch off latest `dev`.** Never reuse a merged or unrelated branch — one branch + PR per change.
- **New feature → ADR.** A feature that adds or changes a product contract or architectural decision gets `docs/adr/NNNN-<slug>.md` (next number) before or with the code — supersede the old ADR rather than rewriting it. Pure bug fixes, docs-only, and chore/tooling changes do not need one. The prototype's fixture seed does not need a new ADR; it is specified in the PRD.
- **Delegating to a subagent?** A subagent's world is its task prompt — it does not inherit `AGENTS.md` or this file. Inline the conventions the subtask needs (branch format, commit subjects, review gates) in the dispatch.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): summary

optional body explaining why
```

- `type` — required; see table below
- `scope` — required; short area (`mcp`, `seed`, `d1`, `skills`, `docs`, `ci`, `repo`, …)
- `summary` — imperative, lowercase after the colon, ≤72 chars total subject line, no trailing period
- `body` — optional; explain **why**, not a file list. Use bullets for multi-part milestones

```text
✅ feat(mcp): add lookup_rates with tag filter and limit
✅ docs(repo): lock facts-only boundary in an ADR

❌ Add the MCP worker                      # missing type(scope)
❌ feat: add stuff                         # missing scope; vague summary
❌ feat(mcp): Added lookup_rates.          # past tense + trailing period
```

| Type | When |
|------|------|
| `feat` | New user-facing capability or tool |
| `fix` | Bug fix |
| `refactor` | Behavior-preserving code change |
| `docs` | Docs / roadmap / status only |
| `chore` | Tooling, deps, ignore files, misc |
| `test` | Tests only |
| `ci` | CI/CD config |
| `perf` | Performance improvement |

Prefer domain names for `scope`: `mcp`, `seed`, `d1`, `skills`, `docs`, `repo`. Prefer why over what. Never put secrets or env values in messages. Keep the **subject line ASCII-only** — put Chinese detail in the body if needed.

## Branch names

Follow the [Conventional Branch](https://conventionalbranch.org/) purpose prefixes: `feat/…` (or `feature/…`), `fix/…` (or `bugfix/…`), `hotfix/…`, `release/…` (dots OK for versions, e.g. `release/v0.1.0`), `chore/…`. Slug is lowercase, hyphen-separated — e.g. `feat/lookup-rates`. There is no `ci/`, `docs/`, `test/`, `refactor/`, or `perf/` branch — branch type is work intent, not commit type: CI-config, docs, refactor, and test-only work all branch under `chore/…` (their commits still use the commit-type table above).

## Pull requests

- **Title** — same format as commit subjects (`type(scope): summary`, ≤72 chars, ASCII-only); use the dominant change's type/scope. The `conventions` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) rejects a PR whose branch, title, or commit subjects do not match.
- **Body** — follow `.github/pull_request_template.md`: `## Summary` (what + why), `#### Test plan`, plus the `ADR:` / `Breaking:` lines. CI does not read the body.
- **Contract gate** — CI's `contract` job ([`scripts/contract-gate.mjs`](../scripts/contract-gate.mjs)) checks drift both ways: touching `src/query.ts`, `src/server.ts`, or `migrations/` requires a `docs/PRD.md` or `docs/adr/` change in the same PR, and added table rows in PRD §4–§6 require a touched `*.test.ts`. The `contract-exempt` label opts a PR out — apply it deliberately, not to get green.
- **Dependency updates** — Dependabot alerts are a Security-tab signal, not automation: no version- or security-update bot PRs, because security PRs always target `main` and would bypass the dev flow. Bumps — including CVE fixes — come through a normal `chore/` branch + PR.
- **Merge method** — merge commit only, once branch protection exists: commit subjects land on `main` individually; the PR title does not.
- **Integration branches** — `dev`, `develop`, `main`, `master` are exempt from the head-branch check, so `dev` → `main` promotions and backmerges open straight from the integration branch (a `release/` branch still works if a stabilization line is wanted).
