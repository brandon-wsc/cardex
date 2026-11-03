---
name: graphify
description: "Cardex knowledge graph — for architecture, file-relationship, and impact questions read the published graph first; it needs no local tooling. Live at https://cardex-graph.unhinted.workers.dev."
triggers:
  - user
  - model
---

# Cardex knowledge graph

This repo publishes a graphify knowledge graph on every dev push.
Fetch it over HTTP — works for any agent, no local install:

- Report (start here): https://cardex-graph.unhinted.workers.dev/GRAPH_REPORT.md
- Full graph (GraphRAG-ready JSON): https://cardex-graph.unhinted.workers.dev/graph.json
- Interactive viz (for humans): https://cardex-graph.unhinted.workers.dev/graph.html

`graph.json` nodes carry `source_file` and edges carry type/confidence —
curl it and answer "what does X connect to" / "what depends on Y" /
"which files are in community N" without checking anything out.

The graph is a derived view — `AGENTS.md`, `docs/PRD.md`, `docs/adr/`
stay authoritative when they disagree.

## If the graphify CLI is installed (optional)

Check `command -v graphify`. When present, the local graph is fresher
and queryable:

```bash
graphify update .            # rebuild graphify-out/ (AST-only, free)
graphify explain "<node>"    # symbol/file + its neighbors
graphify query "<question>"  # BFS context for a question
graphify path "A" "B"        # shortest path between two nodes
graphify affected "<x>"      # what a change to X impacts
graphify god-nodes           # most-connected hubs
```

`.graphifyignore` keeps config-key noise (workflows, package.json,
tsconfig, generated artifacts) out of the graph — extend it if junk
communities appear in the report.
