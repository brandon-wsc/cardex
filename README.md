# Cardex

Cardex gives personal agents structured facts about Hong Kong credit cards — rebate rates, earning rules, caps, and terms. It is a pair: an **Agent Skill** ([`skills/cardex`](skills/cardex/SKILL.md)) that teaches the agent how to reason, and a public **remote MCP** endpoint that returns the records. The agent does its own ranking; Cardex never names a best card.

> **Status:** pre-alpha, live at `cardex.brandonhk.com`. `packages/mcp-worker` is a Cloudflare Worker serving the MCP over D1. The seed is synthetic; no real issuer terms yet.

## Install the skill

The skill is the product surface — your agent installs it and learns how to connect, which tool to reach for, and how to settle terms it cannot check.

- **From this repo** — copy [`skills/cardex/`](skills/cardex/) into your agent's skills directory.
- **From a GitHub Release** — packaged skill (first release pending).
- **No skill support?** Connect any MCP client to the endpoint directly — `POST https://cardex.brandonhk.com/mcp`, streamable HTTP, no auth:

```json
{ "mcpServers": { "cardex": { "url": "https://cardex.brandonhk.com/mcp" } } }
```

Two more surfaces share the Worker ([ADR 0002](docs/adr/0002-maintenance-surface.md)): `POST /maintainer`, a bearer-token MCP the maintenance agent uses to read quarantined reports and file structured proposals (runbook: [`skills/cardex-maintainer`](skills/cardex-maintainer/SKILL.md)); and `/admin`, a Cloudflare Access portal where the owner approves or rejects proposals. Only approved proposals ever write facts.

## What Cardex is

- **Agent-facing.** The callers are other AIs (assistants, agents, copilots) that need reliable card data. People do not use Cardex directly.
- **Facts, not advice.** Cardex returns structured records. It does not choose "the best card" for anyone. Ranking and judgment stay with the calling agent.
- **Small, composable outputs.** Tools return compact results. Callers narrow them with filters, `limit`, and follow-up lookups by `id`. They do not get a whole dataset in one response.

## What Cardex is not

- Not a consumer "which card should I use" app. It does not compete with SwipeWhich, 小斯, or similar products.
- Not a wallet or card-management product. It stores no user cards, transactions, or personal data.
- Not a live scraper. Data is curated facts in D1 — nothing is scraped at request time.
- Not a RAG system. Lookups are structured queries, not embedding search over documents.

## Tools

| Tool               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `lookup_rates`     | Find rebate/earning rates by tag, card, or issuer, with filters and `limit` |
| `get_card`         | Fetch one card's details by `id`                                         |
| `get_term`         | Fetch a specific term/condition (cap, exclusion, validity) by `id`       |
| `list_tags`        | List known spend tags                                                    |
| `resolve_alias`    | Map a free-text name to canonical tag(s) or card(s)                      |
| `score_candidates` | Score cards for a spend under explicit `assumptions`, and report `unknown_exclusions` |
| `report_issue`     | File a wrong-or-stale fact into the quarantine queue for the maintenance loop |

`score_candidates` stays a fact-based calculation. It shows the assumptions it used and lists exclusions it could not check, so the calling agent can decide what to do.

## Architecture (v1)

| Layer    | Choice                                    |
| -------- | ----------------------------------------- |
| Runtime  | Cloudflare Workers                        |
| Language | JavaScript / TypeScript                   |
| Storage  | Cloudflare D1 (SQLite)                    |
| Data     | Curated facts in D1; `seed.sql` is the dev snapshot |
| Protocol | MCP (remote server)                       |

### Data model

- **Cards** link to **rates** (earning rules) and **terms** (conditions, caps, exclusions).
- **Tags** classify merchants and spend categories (for example `dining`, `online`, `overseas`). Tags and rates are many-to-many, and tags can overlap. One spend can match several tags.
- **Aliases** map free-text names (merchant names, nicknames, abbreviations) to canonical tags or cards, also many-to-many.

## Run it

Local development:

```bash
pnpm install
pnpm migrate   # apply D1 schema to the local database
pnpm seed      # load seed/seed.sql (synthetic data)
pnpm dev       # wrangler dev — MCP at http://localhost:8787/mcp
```

`pnpm demo` runs all three setup steps, boots `wrangler dev`, and prints eight scripted tool payloads (a real MCP client over HTTP). Rates in that output are invented fixtures, not issuer terms. The spec is [`docs/PRD.md`](docs/PRD.md).

## Docs

| Doc | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Coding-agent entry: sources of truth, hard boundaries, commit rules |
| [CONTEXT.md](CONTEXT.md) | Domain language |
| [docs/PRD.md](docs/PRD.md) | Product spec |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases after v1 |
| [docs/STATUS.md](docs/STATUS.md) | What exists today |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [docs/TESTING.md](docs/TESTING.md) | Test policy |
| [docs/ai-workflow.md](docs/ai-workflow.md) | AI-assisted development notes |

This repo is also a public demo of an AI-assisted development workflow (Pinnacle). The writeup is planned at `docs/ai-workflow.md` and is not written yet.

## Repository layout

```
.
├── AGENTS.md             # Coding-agent entry
├── CONTEXT.md            # Domain language
├── packages/
│   └── mcp-worker/       # Cloudflare Worker: remote MCP over D1 (wrangler dev locally)
├── skills/
│   ├── cardex/           # Agent Skill: the caller playbook (the product surface)
│   └── cardex-maintainer/# Agent Skill: triage reports + file proposals via /maintainer
├── seed/
│   └── seed.sql          # Synthetic sample data (invented numbers, not issuer terms)
├── docs/
│   ├── ROADMAP.md
│   ├── STATUS.md
│   ├── TESTING.md
│   ├── adr/
│   └── ai-workflow.md    # AI-assisted development notes
├── LICENSE               # Named MIT; file not added yet
└── README.md
```

## Data policy

- No card numbers (PANs), personal data, or secrets are stored in this repo.
- No scraped dumps are committed. Seed data is curated; the v1 seed is synthetic (placeholder `source_url`s) until the cited seed lands.
- Card terms change often, so always confirm against the issuer before relying on a value.

## License

[MIT](LICENSE)
