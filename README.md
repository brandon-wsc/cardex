# Cardex

Cardex is an MCP server that gives AI agents structured facts about Hong Kong credit cards: rebate rates, earning rules, caps, and terms. Agents call it and do their own reasoning.

> **Status:** pre-alpha. `packages/mcp-worker` is a Cloudflare Worker serving a remote MCP over D1. The seed is synthetic; no real issuer terms yet.

## Docs

| Doc | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Coding-agent entry: sources of truth, hard boundaries, commit rules |
| [CONTEXT.md](CONTEXT.md) | Domain language |
| [docs/PRD.md](docs/PRD.md) | Product spec |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases after v1 |
| [docs/STATUS.md](docs/STATUS.md) | What exists today |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [docs/TESTING.md](docs/TESTING.md) | Test policy (no runner yet) |
| [docs/ai-workflow.md](docs/ai-workflow.md) | AI-assisted development notes |

## Run it

```bash
pnpm install
pnpm migrate   # apply D1 schema to the local database
pnpm seed      # load seed/seed.sql (synthetic data)
pnpm dev       # wrangler dev — MCP at http://localhost:8787/mcp
```

`pnpm demo` runs all three setup steps, boots `wrangler dev`, and prints eight scripted tool payloads (a real MCP client over HTTP). Rates in that output are invented fixtures, not issuer terms. The spec is [`docs/PRD.md`](docs/PRD.md).

## Connect an agent

The endpoint is `POST /mcp` (streamable HTTP). [`skills/cardex`](skills/cardex/SKILL.md) is the Agent Skill that teaches a caller how to connect and which tool to reach for; install it from this repo or a GitHub Release.

## What Cardex is

- **Agent-facing.** The callers are other AIs (assistants, agents, copilots) that need reliable card data. People do not use Cardex directly.
- **Facts, not advice.** Cardex returns structured records. It does not choose "the best card" for anyone. Ranking and judgment stay with the calling agent.
- **Small, composable outputs.** Tools return compact results. Callers narrow them with filters, `limit`, and follow-up lookups by `id`. They do not get a whole dataset in one response.

## What Cardex is not

- Not a consumer "which card should I use" app. It does not compete with SwipeWhich, 小斯, or similar products.
- Not a wallet or card-management product. It stores no user cards, transactions, or personal data.
- Not a live scraper. Data is curated facts in D1 — nothing is scraped at request time.
- Not a RAG system. Lookups are structured queries, not embedding search over documents.

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

## Tools

| Tool               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `lookup_rates`     | Find rebate/earning rates by tag, card, or issuer, with filters and `limit` |
| `get_card`         | Fetch one card's details by `id`                                         |
| `get_term`         | Fetch a specific term/condition (cap, exclusion, validity) by `id`       |
| `list_tags`        | List known spend tags                                                    |
| `resolve_alias`    | Map a free-text name to canonical tag(s) or card(s)                      |
| `score_candidates` | *(optional)* Score cards for a spend under explicit `assumptions`, and report `unknown_exclusions` |

`score_candidates` stays a fact-based calculation. It shows the assumptions it used and lists exclusions it could not check, so the calling agent can decide what to do.

## Repository layout

```
.
├── AGENTS.md             # Coding-agent entry
├── CONTEXT.md            # Domain language
├── packages/
│   └── mcp-worker/       # Cloudflare Worker: remote MCP over D1 (wrangler dev locally)
├── skills/
│   └── cardex/           # Agent Skill: how to connect to the remote MCP
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

## Distribution

- **Remote MCP** runs on Cloudflare Workers.
- **Agent Skill** is published through GitHub Releases. Agents install it to learn how to connect to and query the remote MCP.

This repo is also a public demo of an AI-assisted development workflow (Pinnacle). The writeup is planned at `docs/ai-workflow.md` and is not written yet.

## Data policy

- No card numbers (PANs), personal data, or secrets are stored in this repo.
- No scraped dumps are committed. Seed data is curated; the v1 seed is synthetic (placeholder `source_url`s) until the cited seed lands.
- Card terms change often, so always confirm against the issuer before relying on a value.

## License

[MIT](LICENSE)
