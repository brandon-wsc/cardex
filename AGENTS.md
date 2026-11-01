# Agent brief — Cardex

Short map for coding agents. Prefer these sources over inventing parallel docs or shapes.

Execution conventions (commits, branches, pull requests) live **in this file**. Do not keep a second copy in harness-specific packs (`.cursor/rules`, `CLAUDE.md`, and similar). A tool may *point* here; it must not own the rules.

## What this is

Remote MCP server of structured Hong Kong credit-card facts. Callers are other agents. Cardex returns records; the caller ranks them.

## Single sources of truth

| Concern | Authority | Notes |
|---------|-----------|--------|
| Domain language | [`CONTEXT.md`](CONTEXT.md) | Glossary only — no implementation |
| Product behavior | [`docs/PRD.md`](docs/PRD.md) | Read it before changing tool behavior, and update it when a decision changes |
| Phases | [`docs/ROADMAP.md`](docs/ROADMAP.md) | What comes after the prototype |
| Shipped vs held | [`docs/STATUS.md`](docs/STATUS.md) | What is actually in the tree |
| Locked decisions (ADR) | [`docs/adr/`](docs/adr/) | Prefer ADR over chat memory |
| Public pitch | [`README.md`](README.md) | Human intro. PRD and ADR win if they disagree |
| Tool I/O | [`packages/mcp-worker/src/query.ts`](packages/mcp-worker/src/query.ts) | D1-backed shapes. PRD describes them; do not add a second shape doc |
| Test policy | [`docs/TESTING.md`](docs/TESTING.md) | No runner yet. `pnpm demo` is the check |
| Agent execution | this file | Commits, branches, PRs |

## Hard boundaries

1. **Facts only** — Tools return cards, rates, terms, tags, and aliases. Cardex does not name a best card. `score_candidates`, if built, calculates under the caller's `assumptions` and lists `unknown_exclusions` ([ADR 0001](docs/adr/0001-product-shape.md)).
2. **Curated facts** — Query data lives in D1 and changes only through the propose→approve→apply loop; `seed.sql` is a generated dev snapshot, not the truth. Lookups are structured. Request-time scraping and embedding search stay out ([ADR 0002](docs/adr/0002-maintenance-surface.md)).
3. **No personal data** — No PANs, saved user cards, transactions, or other personal data ([ADR 0001](docs/adr/0001-product-shape.md)).
4. **Compact results** — Every list tool takes filters and `limit`. Callers follow up with `get_card` / `get_term` by `id`. A tool does not return the whole catalog.

## Before changing behavior

1. Read [`docs/PRD.md`](docs/PRD.md). Check whether an ADR or STATUS already locks the behavior.
2. If changing a product contract, **update the PRD first** (and add or supersede an ADR when the change is hard to reverse), then code.
3. Tool payloads live in `packages/mcp-worker/src/query.ts`. Do not invent a parallel shape written only in prose.

## Working agreements

- **Test first.** A change to tool behavior (`query.ts`, migrations, scoring) lands with its failing test first: write the vitest spec, watch it fail, implement, go green. Spec names state behavior in BDD style — one test per PRD §5/§6 table row. No gherkin layer — the PRD tables are the spec.
- **Owner review gates.** D1 schema (`migrations/`, wrangler DB config) and any UI surface require the owner's explicit review before merge — an agent may draft them, never self-approve. Fact changes are approved in the `/admin` portal over structured proposals ([ADR 0002](docs/adr/0002-maintenance-surface.md)).
- **MCP surface.** Streamable HTTP, stateless — whatever the pinned `@modelcontextprotocol/server` 2.x implements. No legacy SSE transport, no stdio variant in v1. The supported standard moves by dependency update, never by ad-hoc contract edits. Three surfaces per [ADR 0002](docs/adr/0002-maintenance-surface.md): `POST /mcp` public, `POST /maintainer` bearer-token (`MAINTAINER_TOKEN`; `list_reports` + `propose_change` + fact reads — proposals only, never facts), `/admin` + `/admin/api/*` behind Cloudflare Access with a `Cf-Access-Authenticated-User-Email` + `ADMIN_EMAIL` check and optional `ADMIN_PIN`. Patches are structured `{op, table, id, key?, set?}` whitelisted in `maintain.ts` — never raw SQL. The whitelist covers tables only; column sets are read live from `PRAGMA table_info`, so a new column on a facts table is patchable with no code change (a new table still needs an explicit whitelist entry).

## Worker

`packages/mcp-worker` is the v1 Worker: a remote MCP endpoint (`/mcp`, streamable HTTP via `createMcpHandler` from the agents SDK — not deprecated `McpAgent`) backed by D1. Query data lives in D1 — `seed/seed.sql` loads it locally and becomes a generated export snapshot in prod ([ADR 0002](docs/adr/0002-maintenance-surface.md)); numbers are synthetic for now and every payload marks `provenance.illustrative`. Runtime rules live in `wrangler.jsonc` and the Cloudflare Workers guidance; this file does not copy them. The compatibility date is the day the Worker was created (or the newest date the pinned workerd supports), and logs and traces are on (`observability.enabled`, `observability.traces.enabled`). `pnpm types` regenerates `worker-configuration.d.ts` after config changes.

## Quick commands

```bash
pnpm install
pnpm migrate    # apply D1 migrations to the local database
pnpm seed       # load seed/seed.sql into local D1
pnpm export-seed # rebuild seed/seed.sql from prod D1 (facts tables only)
pnpm dev        # wrangler dev — MCP at http://localhost:8787/mcp
pnpm demo       # migrate + seed + scripted MCP calls over wrangler dev
pnpm test       # vitest — specs from the PRD tables, inside workerd + real D1
pnpm typecheck
```

Package manager is pnpm (`packageManager` in the root `package.json`). `.npmrc` sets `minimum-release-age=10080` (minutes). Install with a pinned version published at least 7 days ago. Never use `latest` or an unbounded range, and never weaken `.npmrc` to get an install through.

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
- **Merge method** — merge commit only, once branch protection exists: commit subjects land on `main` individually; the PR title does not.

## Feature work

- **Do not commit to, merge into, or push `main`.** Work on a feature branch. The repo owner updates `main` and handles PRs.
- **New feature / fix → fresh branch off latest `main`.** Never reuse a merged or unrelated branch — one branch + PR per change.
- **New feature → ADR.** A feature that adds or changes a product contract or architectural decision gets `docs/adr/NNNN-<slug>.md` (next number) before or with the code — supersede the old ADR rather than rewriting it. Pure bug fixes, docs-only, and chore/tooling changes do not need one. The prototype's fixture seed does not need a new ADR; it is specified in the PRD.

## When reviewing changes

- Flag a tool that names a best card, hides the assumptions it used, or drops exclusions it could not check.
- Flag request-time scraping, embedding search, or a second query store beside D1.
- Flag PANs, saved user cards, transactions, or other personal data.
- Flag a list tool with no `limit`, or a response that dumps the catalog.
