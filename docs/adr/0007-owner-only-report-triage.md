# ADR 0007 — Owner-only report triage

- **Status:** Accepted
- **Date:** 2026-11-02
- **Supersedes:** [0002](0002-maintenance-surface.md) §"Three surfaces, three credentials" item 2, for report reads only

## Context

Public callers can submit arbitrary text and evidence URLs through `report_issue`. The maintainer MCP's `list_reports` returned that text directly to a maintenance agent with capabilities beyond Cardex. Restricting its Cardex token to proposals does not restrict its other tools; instructions embedded in a report could cross that trust boundary.

## Decision

Remove `list_reports` from `/maintainer`. The owner reviews quarantined reports through the existing authenticated `/admin/api/reports` portal endpoint, verifies leads independently, and may assign a specific task to the agent. The maintainer retains fact reads and `propose_change` but has no report-read tool. Public report intake and admin review are unchanged. The portal ships a human-only JSON export — a paged download over the same authenticated endpoint — and reports remain excluded from the generated seed snapshot.

## Consequences

- Untrusted report text no longer flows directly from D1 to the maintenance agent through Cardex MCP.
- Automated maintainer runs can still check issuer sources and propose changes, but cannot automatically triage public submissions.
- This boundary assumes the agent is not separately given an admin session, D1 credentials, or a report export; those would re-open the path.
