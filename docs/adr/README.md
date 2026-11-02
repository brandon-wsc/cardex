# Architecture Decision Records

Product and architecture decisions. STATUS may point here; **ADRs are the record**.

| ID | Title | Status |
|----|-------|--------|
| [0001](./0001-product-shape.md) | Product shape: playbook over a public, human-maintained facts backend | Accepted — parts superseded by 0002 |
| [0002](./0002-maintenance-surface.md) | Maintenance surface: D1 as truth, proposals + portal, agent at capability distance | Accepted — report reads superseded by 0007 |
| [0003](./0003-facts-language.md) | Facts are English-canonical; other languages live in the lookup layer | Accepted |
| [0004](./0004-public-site.md) | Public site on the same Worker: Astro static assets, Preact admin island | Accepted |
| [0005](./0005-record-provenance.md) | Per-record provenance, computed envelope | Accepted |
| [0006](./0006-score-currency.md) | Currency-aware scoring input | Accepted |
| [0007](./0007-owner-only-report-triage.md) | Owner-only report triage | Accepted — supersedes 0002 report reads |

## Format

Each ADR: Context → Decision → Consequences. To reverse a decision, add a new ADR that **supersedes** the old one. Do not rewrite history.
