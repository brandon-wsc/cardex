# AI-assisted workflow

How this repo was actually built: coding agents wrote the code, a manager agent ran the loop, and a human held the review gates that mattered. Written for the Pinnacle brief — tools used, key steps, time, and how the work was checked. The standing rules this ran under live in [AGENTS.md](../AGENTS.md); this file describes one build, it does not own any conventions.

## Tools that ran

| Tool | Role |
|------|------|
| **Devin** | Primary code author — most commits on `main` |
| **Cursor** | Secondary coding agent — also wrote code |
| **Grok Bot** | Organize / test / review — the manager. Drove the Devin sessions, triaged PRs, ran checks. Does not self-commit |
| **Hermes / Instinct** | Personal-agent testing — exercised the public `/mcp` the way a real caller would |
| **Paseo** | Agent development environment — worktree isolation and conflict handling for the Devin sessions |
| **GitHub Actions** | CI gate: branch/PR-title/commit conventions, vitest, typecheck, deploy to Cloudflare |

One deliberate consequence of the split: agents that write code commit under the owner's configured identity on owner-approved branches; the manager never pushes. The git trail stays auditable — every commit is a Conventional Commit subject a reviewer can read.

## The loop

1. **Discuss.** Contract first — a PRD table row, an ADR, or a STATUS update lands before or with the code, not after. Disagreements resolved against the doc, not chat memory.
2. **Implement.** Devin on a fresh `type/slug` branch off `main` (Cursor as secondary — that build predates the `dev` trunk; the convention is now off `dev`, see [`docs/EXECUTION.md`](EXECUTION.md)), test-first for tool behavior: vitest spec from the PRD row, watch it fail, implement, go green.
3. **PR.** One change → one branch → one PR. CI's `conventions` job rejects sloppy branches, titles, and commit subjects before a human ever looks.
4. **Review.** Grok Bot ran the checks and reviewed the diff; judgment calls escalated to the owner.
5. **Owner gates.** Brandon personally reviewed every D1 schema change and every UI surface before merge — that was a real gate, not a rubber stamp (see below for the gate that wasn't).
6. **Deploy.** Merge → [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) → `wrangler deploy`. One Cloudflare Worker serves the site, `/mcp`, `/maintainer`, and `/admin`; prod D1 migrations apply in the same run.

Facts move on a separate track from code: `report_issue` files a wrong-or-stale fact into quarantine, the maintenance agent files a structured `propose_change` over `POST /maintainer` (patches whitelisted in `maintain.ts`, never raw SQL), and the owner approves in `/admin`. Only approved proposals write facts — [ADR 0002](adr/0002-maintenance-surface.md). `seed/seed.sql` is a generated export of that loop's output, not a file you hand-edit.

## Time

**≈30 hours wall clock across two calendar days** — commit-derived, not a marketing number. The window is frozen at the `v0.4.0` release; it measures the MVP build this file describes:

- Repo created / first recorded activity: **~2026-10-31 12:09 UTC**
- Measurement end: **2026-11-01 17:45 UTC** — the `v0.4.0` release tag is the MVP line

Caveat for anyone replicating the measurement: the prototype landed as a squash merge (PR #3 is the tree root), so day-one commits are not individually visible in `git log`. The honest span is repo-created → `v0.4.0`. 19 PRs and 98 commits shipped inside that window.

Everything merged after `v0.4.0` — `score_candidates`, the maintenance-surface hardening, the tooling below — is post-MVP iteration on the same loop, not part of the number. Stretching the window to "however long the repo has been alive" would turn a checkable figure into a vibes claim.

## How it was checked

- **Automated** — vitest inside workerd against real D1, one spec per PRD §5/§6 table row; wire-level tests through a real MCP `Client`; typecheck; the CI conventions gate. `pnpm demo` exercises the live tool surface end-to-end. Policy: [TESTING.md](TESTING.md).
- **Manager review** — Grok Bot reviewed every PR and ran the suite; because it never commits, "the agent approved its own work" never enters the trail.
- **Live deploy** — the checkable artifact is the real Cloudflare Workers deployment, not a staging mock: `deploy.yml` builds the site, applies prod D1 migrations, then `wrangler deploy`s on every merge to `main`. Any reviewer can `curl https://cardex.brandonhk.com/mcp` zero-install and get the same payload shape the tests assert.
- **Owner gates, the honest version:**
  - *Schema review* (migrations, wrangler DB config): **real.** Every schema change got a personal read before merge.
  - *UI review* (admin portal, landing page): **real.**
  - *Proposal approve in `/admin`*: **expedient, not a deep fact audit.** At proposal density the admin UI was hard to read, and approvals were often given to unblock the loop. The structured-patch whitelist and quarantine queue kept that safe; the fact-checking depth was thin. Do not read the approve log as "every proposal carefully verified" — readable proposal diffs are a known follow-up, not a claim we make.

## What kept it honest

- Docs are the contract: [PRD](PRD.md), [ADRs](adr/), [STATUS](STATUS.md) updated before or with code.
- Hard boundaries in [AGENTS.md](../AGENTS.md) — facts only, curated facts, no personal data, compact results — plus a review checklist for the exact ways agents drift (naming a best card, dumping the catalog, scraping at request time).
- Pinned deps with a 7-day release-age floor, so an agent cannot YOLO-install a day-old package.
- Conventional Commits / Branches enforced in CI, so the agent-generated history is greppable.

The result is a repo where "built by AI in two days" is verifiable: read the ADRs for the decisions, `git log` for the pace, and this file for who (or what) did which part.

## Since the brief — 2026-11 tooling

Two wirings landed after the build above. Both are agent-facing infrastructure, not product surface; the retrospective above stays as it was.

**Knowledge graph (graphify).** Every push to `dev` rebuilds an AST-only code graph and deploys it to a separate static-assets Worker ([`.github/workflows/graphify.yml`](../.github/workflows/graphify.yml) → [`graphify.wrangler.jsonc`](../graphify.wrangler.jsonc)); a daily job layers LLM semantic enrichment on top ([`graphify-semantic.yml`](../.github/workflows/graphify-semantic.yml) — the only workflow holding an LLM key). Trunk-only on purpose: PR content never reaches the published graph. Agents fetch `GRAPH_REPORT.md` / `graph.json` from `cardex-graph.unhinted.workers.dev` for architecture and impact questions instead of re-deriving the codebase locally — [`.agents/skills/graphify`](../.agents/skills/graphify/SKILL.md) is the pointer. The graph is a derived view; AGENTS.md, the PRD, and ADRs stay authoritative on disagreement.

**Tickets (Linear).** Test-agent findings used to land as hand-edited notes — the bottleneck moved from writing code to writing down what the code should do. Now Hermes/Instinct and Grok Bot file Linear tickets over MCP themselves, and the owner triages the queue: decides what becomes work and what gets dropped. Nothing Linear lives in this repo — the wiring is MCP config on the agents' side, so there is no in-tree artifact to audit.

When a ticket drives a change, its key goes in the branch slug — `fix/car-123-unmapped-merchant`. That already passes the `conventions` CI regex (digits are legal in slugs), while PR titles can't carry the uppercase key — so the branch is the canonical ticket↔code link and no CI change was needed. Unticketed work keeps a plain `type/slug`.
