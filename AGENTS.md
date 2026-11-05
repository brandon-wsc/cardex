# Agent brief — Cardex

Short map for coding agents. Prefer these sources over inventing parallel docs or shapes.

Execution conventions (commits, branches, pull requests) live in [`docs/EXECUTION.md`](docs/EXECUTION.md) — read it before committing, branching, or opening a PR. Do not keep a second copy in harness-specific packs (`.cursor/rules`, `CLAUDE.md`, and similar). A tool may *point* here; it must not own the rules.

## What this is

Remote MCP server of structured Hong Kong credit-card facts. Callers are other agents. Cardex returns records; the caller ranks them.

Code lives in `packages/mcp-worker` (remote MCP endpoint + D1) and `packages/site` (Astro static; its `dist/` is the Worker's assets). Each package has its own `AGENTS.md` with package detail — read it before working there.

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
| Test policy | [`docs/TESTING.md`](docs/TESTING.md) | `pnpm test` — vitest in workerd on real D1; `pnpm demo` is the e2e check |
| Site copy | [`packages/site/src/i18n/`](packages/site/src/i18n/) | `zh-HK.ts` defines the shape, `en.ts` must match. No copy strings in components. The README prompts mirror `prompt.text` ([ADR 0004](docs/adr/0004-public-site.md)) |
| Worker package | [`packages/mcp-worker/AGENTS.md`](packages/mcp-worker/AGENTS.md) | Runtime, D1 seed, TypeScript — read before working in the package |
| Site package | [`packages/site/AGENTS.md`](packages/site/AGENTS.md) | Copy rules, Astro/TS versions — read before working in the package |
| Agent execution | [`docs/EXECUTION.md`](docs/EXECUTION.md) | Commits, branches, PRs — read before committing, branching, or opening a PR |

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
- **Owner review gates.** D1 schema (`migrations/`, wrangler DB config) and any UI surface require the owner's explicit review before merge — an agent may draft them, never self-approve. `.github/CODEOWNERS` maps the same paths so GitHub auto-requests the owner; do not widen or edit it to dodge the gate. Fact changes are approved in the `/admin` portal over structured proposals ([ADR 0002](docs/adr/0002-maintenance-surface.md)).
- **MCP surface.** Streamable HTTP, stateless — whatever the pinned `@modelcontextprotocol/server` 2.x implements; the standard moves by dependency update, never by ad-hoc contract edits. Three surfaces: `POST /mcp` public, `POST /maintainer` bearer-token (`MAINTAINER_TOKEN`), `/admin` + `/admin/api/*` behind Cloudflare Access with fail-closed identity — auth and scope details in [ADR 0002](docs/adr/0002-maintenance-surface.md), [ADR 0007](docs/adr/0007-owner-only-report-triage.md), [ADR 0008](docs/adr/0008-admin-identity-fail-closed.md). Patches are structured `{op, table, id, key?, set?}` whitelisted in `maintain.ts` — never raw SQL.

## Quick commands

```bash
pnpm install
pnpm migrate    # apply D1 migrations to the local database
pnpm seed       # load seed/seed.sql into local D1
pnpm export-seed # rebuild seed/seed.sql from prod D1 (facts tables only)
pnpm dev        # build site, then wrangler dev — site at http://localhost:8787, MCP at /mcp
pnpm dev:site   # Astro dev server for page work (no /mcp, no /admin/api)
pnpm build:site # astro check + build → packages/site/dist (needed before test/dev/deploy)
pnpm demo       # build site + migrate + seed + scripted MCP calls over wrangler dev
pnpm test       # vitest — specs from the PRD tables, inside workerd + real D1
pnpm typecheck  # Worker tsc + astro check
pnpm dup        # jscpd clone scan → docs/dup-baseline/ (advisory, no gate)
```

Package manager is pnpm (`packageManager` in the root `package.json`). `.npmrc` sets `minimum-release-age=10080` (minutes). Install with a pinned version published at least 7 days ago. Never use `latest` or an unbounded range, and never weaken `.npmrc` to get an install through.

## Feature work

- **Do not commit to, merge into, or push `main`.** Work on a feature branch — fresh off latest `dev`, one branch + PR per change. The repo owner updates `main` and handles PRs. Conventions: [`docs/EXECUTION.md`](docs/EXECUTION.md).

## When reviewing changes

- Flag a tool that names a best card, hides the assumptions it used, or drops exclusions it could not check.
- Flag request-time scraping, embedding search, or a second query store beside D1.
- Flag PANs, saved user cards, transactions, or other personal data.
- Flag a list tool with no `limit`, or a response that dumps the catalog.
