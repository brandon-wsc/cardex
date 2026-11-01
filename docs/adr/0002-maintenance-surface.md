# ADR 0002 — Maintenance surface: D1 as truth, proposals + portal, agent at capability distance

- **Status:** Accepted
- **Date:** 2026-11-01
- **Supersedes:** [0001](0001-product-shape.md) §"Curated seed, human-approved maintenance" items 3–4, and §"Public remote MCP on Workers and D1" item 4

## Context

ADR 0001 made `seed/seed.sql` the source of truth and pull requests the approval surface — the right choice when there was no write API and the reviewer was a human reading diffs. Committing to a maintenance agent plus an approval portal exposes two problems with that shape:

- **The system is already split-brain on persistence.** `reports` live only in D1; `proposals` will too. Facts were the only data whose truth was a file — and the file was truth because it was the review surface, not because files persist better. Once review moves into a portal, the git layer under facts is redundant, and any second writer beside the seed file guarantees approved data eventually gets wiped by a reseed.
- **A Cloudflare credential that can reach D1 runs arbitrary SQL.** The D1 query endpoint accepts `D1 Read` or `D1 Write` and executes what it is sent; whether `D1 Read` refuses writes is undocumented ([cloudflare-docs#34588](https://github.com/cloudflare/cloudflare-docs/issues/34588)), and token scope is account-wide, not per-database. The agent's boundary must be enforced by capability — what it cannot do — not by instruction.

## Decision

### D1 is the truth for runtime data

1. Facts, reports, and proposals all persist in D1 — one persistence model, no split-brain.
2. `seed/seed.sql` stops being truth. It becomes a generated snapshot for local dev and demo, produced by `wrangler d1 export --remote --no-schema` restricted to facts tables via `--table`, refreshed by a scheduled job. A stale snapshot means stale local data — never lost facts.
3. `reports` and `proposals` are never exported: they hold public submissions and working state, not publishable facts.
4. Vitest fixtures stay hand-maintained — tests never consume the live export, or every sync could break specs.
5. Schema stays in `migrations/` — schema is code-adjacent and stays in git; data lives in D1.

### Three surfaces, three credentials

1. `POST /mcp` — public, unauthenticated. Unchanged from 0001.
2. `POST /maintainer` — a second MCP handler on the same Worker, gated by `Authorization: Bearer` checked against a `MAINTAINER_TOKEN` Worker secret. Exposes `list_reports`, `propose_change`, and fact reads — insert-only into `proposals`; it cannot touch facts tables.
3. `/admin` + `/admin/api/*` — the same Worker serves a minimal portal. Cloudflare Access (email OTP, owner's address only) fronts the path; the Worker also verifies `Cf-Access-Authenticated-User-Email` as a second check. An optional PIN on the approve action is a cheap extra factor — the real separation is the policy split, not the PIN.
4. The maintenance agent holds **no Cloudflare account credential** — no API token with D1 or Workers scope. Its only credential is `MAINTAINER_TOKEN`, whose only capability is inserting proposals.

### Proposals carry structured patches, never raw SQL

1. A proposal is a row in `proposals`: `id`, `proposed_by`, `summary`, `evidence_url`, `excerpt`, `patches` (JSON), `status` (`pending`/`approved`/`rejected`/`applied`), `created_at`, `decided_at`, `decided_by`, `decision_note`.
2. A patch is a whitelisted operation — `{ op: insert|update|delete, table, id, set: {…} }` — restricted to facts tables and named columns, validated at `propose_change` and again at apply. Raw SQL in a proposal would make the proposal channel itself a write path.
3. Approve applies the patches in a transaction and marks the row `applied`; reject records `decision_note`. `decided_by` is the authenticated email from Access.
4. Audit = the `proposals` table (who proposed, the patch, evidence, who decided, when). Rollback = D1 Time Travel. The export snapshot is for dev fidelity, not audit.

## Consequences

- ADR 0001's maintenance *shape* survives — propose → approve → apply, evidence required, the agent never applies. Only the carrier changes: `proposals` rows and a portal replace PRs and seed diffs.
- Cardex gains its first authenticated surfaces. The read path stays public; writes exist only behind the two new credentials.
- The portal is the largest single build in the project so far and lands with the maintenance milestone. Until it ships, approved changes reach prod D1 through the owner's manual `wrangler d1 execute --remote` — the same path that exists today — so this ADR does not block cited-seed work.
- A compromised `MAINTAINER_TOKEN` yields garbage proposals, not facts. A compromised owner mailbox yields approval — mitigated by Access policy and the optional PIN.
- Giving the agent any Cloudflare credential with D1 or Workers scope, accepting raw-SQL patches, letting proposals auto-apply, or adding a second approver — each needs a superseding ADR.
