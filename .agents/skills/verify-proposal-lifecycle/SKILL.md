---
name: verify-proposal-lifecycle
description: Model-checks the proposal decide path in packages/mcp-worker/src/maintain.ts — that patches land at most once and the first decision is final, across overlapping approves, rejects, and conflicting proposals. Use when editing decideProposal, the proposal status guard, or any decide write in maintain.ts.
---

# Proposal lifecycle — decide once, apply once

`decideProposal` in `packages/mcp-worker/src/maintain.ts` awaits a `SELECT status` and then awaits a separate write — one `db.batch` for approve, one `UPDATE` for reject. A second approver can interleave between the two awaits. Two properties guard the harm: a proposal's patches land at most once, and the first decision (`applied` or `rejected`) is final.

The check reads `decideProposal` for two source facts — whether the approve `UPDATE` and the reject `UPDATE` are conditional on `status = 'pending'` — then runs a TLA+ model of the lifecycle through `tla-checker` (a WASM model checker; `pnpm install` is the whole toolchain, no Java). Which spec it runs depends on the code shape: both unconditional → `ProposalLifecycle.tla`, which must produce exactly the findings the code predicts; both conditional → `ProposalLifecycleFixed.tla`, which must pass.

## Run

From the repo root:

```bash
node .agents/skills/verify-proposal-lifecycle/check.mjs
```

Exit 0 means the decide writes are conditional and the fixed model proves both properties. Exit 1 prints one shortest trace per finding in the code's words. Exit 2 means `decideProposal` or its UPDATEs could not be read, the code has a shape no spec models (mixed conditional writes), or the model no longer produces the findings the code predicts — re-read the function before moving the sync commit.

## How to read a failure

- `overlap-read`: two approvers both SELECT `pending` before either batch runs; both batches commit and the patches land twice.
- `decision-override`: after an approve committed (`status = 'applied'`, facts already in the tables), a concurrent reject's unconditional `UPDATE` rewrites the row to `'rejected'`. The audit trail says rejected while the facts stand — no error is returned.
- `NEW finding`: a violation kind the current code shape does not predict. Treat it as a real bug until proven a modeling error.

A missing expected finding, or a `NEW finding` after an edit that did not change the UPDATE shape, means this skill no longer matches the function. Re-read `decideProposal` before moving the sync commit.

## Coverage

Checked at commit `8573f23fbb27e21579e31f702079e16eb9e66829`.

Covers `decideProposal` end to end — the pending read, the JS guard, the reject UPDATE, the approve batch — plus `proposeChange`'s pending-queue cap and proposals that conflict through shared facts rows (apply-time revalidation is modeled as `stale`). Bounds: two proposals, two approvers, `MaxPending = 2`; patches are abstracted to a symmetric conflict relation. It does not cover `validatePatch` internals, patch contents, `term_index_dirty` marks, a failed batch rolling back, rate limits, or the HTTP layer. The state space is small on purpose — interleaving bugs show up at the smallest configuration.

When `maintain.ts` changes after that commit, run this command again. Move the sync commit only after the check still describes the function at the new commit.

## Current findings

Both decide writes are unconditional, so the result is fail with `overlap-read` and `decision-override`. These are findings in the current function, not a broken checker. Do not delete the findings to make the command exit 0.

The fix the model proves: every decide write matches `WHERE id = ? AND status = 'pending'` and treats a zero-row result as `already_decided` (`ProposalLifecycleFixed.tla`, which also shows the recovery obligation a claimed-but-unapplied `'applying'` row creates if the patch batch fails). `verify-proposal-decided-once` covers only the approve–approve overlap; this skill supersedes its scope — keep it anyway as the zero-dependency subset.

## Reading the model

The `.tla` specs and this check's expected findings are the model — read the specs to see the atomicity assumption (one action per await boundary) and the ghost variables (`applied`, `decision`) that make the harm checkable. For a chart of the state graph or a bug path in a reviewer's words, run the pstack `/statechart` skill on a spec — it needs Java and a `tla2tools.jar` (pin `v1.7.4`, sha256 `936a2620…50e88`; the runner parses that version's SANY output). Plain `java -jar tla2tools.jar -config ProposalLifecycle.cfg ProposalLifecycle.tla` works as a second opinion on the checker itself.
