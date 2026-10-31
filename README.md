# Cardex

Cardex is an MCP server that gives AI agents structured facts about Hong Kong credit cards: rebate rates, earning rules, caps, and terms. Agents call it and do their own reasoning.

> **Status:** pre-alpha. This repo has scaffolding only. The MCP Worker is not built yet.

## What Cardex is

- **Agent-facing.** The callers are other AIs (assistants, agents, copilots) that need reliable card data. People do not use Cardex directly.
- **Facts, not advice.** Cardex returns structured records. It does not choose "the best card" for anyone. Ranking and judgment stay with the calling agent.
- **Small, composable outputs.** Tools return compact results. Callers narrow them with filters, `limit`, and follow-up lookups by `id`. They do not get a whole dataset in one response.

## What Cardex is not

- Not a consumer "which card should I use" app. It does not compete with SwipeWhich, 小斯, or similar products.
- Not a wallet or card-management product. It stores no user cards, transactions, or personal data.
- Not a live scraper. Data comes from a curated offline seed. Nothing is scraped at request time.
- Not a RAG system. Lookups are structured queries, not embedding search over documents.

## Architecture (v1)

| Layer    | Choice                                    |
| -------- | ----------------------------------------- |
| Runtime  | Cloudflare Workers                        |
| Language | JavaScript / TypeScript                   |
| Storage  | Cloudflare D1 (SQLite)                    |
| Data     | Curated offline seed, loaded into D1      |
| Protocol | MCP (remote server)                       |

### Data model

- **Cards** link to **rates** (earning rules) and **terms** (conditions, caps, exclusions).
- **Tags** classify merchants and spend categories (for example `dining`, `online`, `overseas`). Tags and rates are many-to-many, and tags can overlap. One spend can match several tags.
- **Aliases** map free-text names (merchant names, nicknames, abbreviations) to canonical tags or cards, also many-to-many.

## Planned tools

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
├── packages/
│   └── mcp-worker/     # Cloudflare Worker serving the remote MCP endpoint (planned)
├── skills/
│   └── cardex/         # Agent Skill that tells agents how to use the remote MCP (planned)
├── docs/
│   └── ai-workflow.md  # Writeup of the AI-assisted development workflow
├── LICENSE
└── README.md
```

## Distribution

- **Remote MCP** runs on Cloudflare Workers.
- **Agent Skill** is published through GitHub Releases. Agents install it to learn how to connect to and query the remote MCP.

This repo is also a public demo of an AI-assisted development workflow (Pinnacle). See [`docs/ai-workflow.md`](docs/ai-workflow.md).

## Data policy

- No card numbers (PANs), personal data, or secrets are stored in this repo.
- No scraped dumps are committed. Seed data is curated and traceable to public sources.
- Card terms change often, so always confirm against the issuer before relying on a value.

## License

[MIT](LICENSE)
