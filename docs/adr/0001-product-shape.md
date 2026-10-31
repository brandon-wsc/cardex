# ADR 0001 — Product shape: playbook over a public, human-maintained facts backend

- **Status:** Accepted — §"Curated seed, human-approved maintenance" items 3–4 and §"Public remote MCP" item 4 superseded by [0002](0002-maintenance-surface.md)
- **Date:** 2026-10-31
- **Supersedes:** —

## Context

Personal agents get asked which Hong Kong credit card to use. Today they guess, or they scrape — and what they scrape is affiliate-ranked comparison content and issuer T&C PDFs: biased toward commission, easy to parse wrong, and different every time. Answering "which is best" directly would turn Cardex into a consumer recommender; the callers are agents that can rank for themselves.

Terms also decay. A seed that is never re-verified silently goes stale — the failure mode that matters for a facts service. Keeping it true is recurring work: re-checking values against issuer sources, noticing expired promos, adding new offers. That is what a maintenance agent is for; what it may not do is change the seed on its own.

And facts alone are close to a commodity. What agents get wrong is judgment — that a promo needs registration, that a foreign-currency fee can exceed the rebate, that a cap resets each statement month. The durable product is a pair: a playbook (how to reason) and a facts backend (what is true now).

## Decision

### Facts only; the caller keeps judgment

1. Tools return structured records: cards, rates, terms, tags, aliases.
2. Cardex does not name a best card and does not store a preference for anyone.
3. `score_candidates` calculates under caller-supplied `assumptions` and reports `unknown_exclusions`. The payload has no winner.
4. The playbook is a caller-side artifact: it ships inside the skill the caller installs and runs in the caller's context. It is advice the caller may follow or ignore; it is not a Cardex answer. Tools, tool descriptions, and payloads never reference it as a recommendation.

### Curated seed, human-approved maintenance

1. Query data comes from a curated offline seed loaded into D1. Each value stays traceable to a public source (`source_url`) and carries `last_verified_at`.
2. Lookups are structured queries by tag, card, issuer, or `id`. The request path does not scrape; git does not hold scraped dumps.
3. Maintenance is a propose → approve → apply loop. The maintenance agent works offline at seed time: it re-checks values against `source_url`, finds stale or missing facts, and opens a pull request carrying evidence (old → new values, source URL, fetch date). The owner reviews and merges; only then is the change applied to D1.
4. The maintenance agent never holds write access to the query store. Its permissions stop at proposing — a bot token that can open PRs, nothing more.
5. `report_issue` accepts fact corrections from any caller into a quarantined `reports` table. Reports are triage input for the same approve-then-apply loop; nothing in them is applied automatically, and no public tool reads them back.
6. Terms carry `effective_from`/`effective_to`; tools filter by `as_of` (default today). An expired term stops matching, so a stale seed degrades to fewer answers — not wrong answers.

### Public remote MCP on Workers and D1

1. The server is a Cloudflare Worker in TypeScript, exposing a remote MCP endpoint, at `packages/mcp-worker`.
2. The query store is Cloudflare D1. The seed is loaded into D1; it is not a second query engine.
3. The read path is public and unauthenticated. Listing tools cap `limit`; enumeration of the whole catalog is an accepted cost of reach.
4. Authorization lives at the merge layer, not the endpoint. The only write path to facts is the owner's merge of a seed change. There is no write API on the Worker; `report_issue` writes only to the quarantined reports table.
5. Cardex stores no PANs, saved user cards, transactions, or other personal data — and it never learns a caller's wallet. The caller asks which cards apply to a spend, suggests candidates to its user, and the user confirms what they hold. Wallet state stays in the caller's memory.

### Playbook skill as the product surface

1. The product surface is the playbook: guidance for how a personal agent answers "which card" questions — what to check (registration requirements, foreign-currency fees, caps, exclusions, effective windows), how to run the suggest → confirm flow, and when to distrust a number.
2. The playbook ships inside `skills/cardex`, which also documents how to call the MCP tools. The skill is the installable unit; the Worker endpoint is its backend.
3. The same playbook content reaches callers three ways: the skill file for harnesses that install skills, the MCP endpoint for chatbots that connect remote servers, and a pasteable form for clients that can do neither. One source of truth in `skills/cardex`.
4. The playbook runs in the caller's context under the facts-only section above: it is Cardex-authored advice the caller may follow or ignore. It teaches how to check; it never names a conclusion.
5. A second skill, `skills/cardex-maintainer`, is the maintenance agent's runbook. A separate artifact for a separate audience — callers never need it.

## Consequences

- `packages/mcp-worker` is infrastructure; `skills/cardex` is the product. Review effort and quality bar go to the playbook accordingly.
- Judgment lives in two places, both outside the tools: the caller's own reasoning, and the playbook it chose to run. The playbook may teach *how to check*; it must never name a conclusion — reviewers flag it the same way they flag a tool that names a best card.
- The playbook works degraded without the endpoint — it still teaches an agent how to verify facts itself — so the product survives backend downtime.
- Freshness is a maintenance loop, not a crawler and not a request-time fetch. A value can still be stale between verifications; `last_verified_at` bounds how stale it could be.
- Spam reports can dirty the quarantine table but cannot touch query data.
- Pull-request review is the approval surface — no admin panel is built. "Two authorized parties" means asymmetric permissions: the agent proposes, the owner merges.
- Any compatible agent connects by pasting a URL — no accounts, no OAuth app to register. The endpoint can be enumerated or flooded; the data is public and reads are cheap. Rate limiting is a later decision if abuse shows up.
- A local-only stdio server, an authenticated read path, any storage of caller or user state, a second query engine, request-path scraping, an agent that applies changes unapproved, or a product that picks a card — each needs a superseding ADR.
