---
name: code-graph
description: "Cardex knowledge graph — for architecture, file-relationship, and impact questions read the published graph first; it needs no local tooling. Live at https://cardex-graph.unhinted.workers.dev."
triggers:
  - user
  - model
---

# Cardex knowledge graph

This repo publishes a graphify knowledge graph on every `dev` push
(daily semantic enrichment on top). Fetch it over HTTP — works for any
agent, no local install:

- Report — agents start here: https://cardex-graph.unhinted.workers.dev/GRAPH_REPORT.md
- Full graph (GraphRAG-ready JSON): https://cardex-graph.unhinted.workers.dev/graph.json
- Interactive viz — for humans; the bare URL redirects here:
  https://cardex-graph.unhinted.workers.dev/

`graph.json` nodes carry `source_file`/`source_location` and `community`;
edges carry `relation` + `confidence_score` (`_origin` splits `ast` from
semantic-inferred). Curl it to answer "what does X connect to" / "what
depends on Y" / "which files are in community N" without checking
anything out. `built_at_commit` records the SHA the graph was built
from — compare it with your checkout before trusting freshness.

The graph is a derived view tracking `dev` — `AGENTS.md`, `docs/PRD.md`,
`docs/adr/` stay authoritative when they disagree.

Maintaining the pipeline (graphify CLI, `.graphifyignore`, the
`graphify*.yml` workflows) is repo-owner territory — a consuming agent
needs nothing local.
