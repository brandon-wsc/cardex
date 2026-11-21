---
name: verify-proposal-decided-once
description: Checks that decideProposal applies one proposal's patches at most once when two approvals overlap. Use when editing decideProposal, the proposal status guard, or the approve UPDATE in packages/mcp-worker/src/maintain.ts.
---

# Proposal patches apply at most once

`decideProposal` in `packages/mcp-worker/src/maintain.ts` reads `status` as a fast path, then claims the proposal with an `UPDATE ... SET status = 'approved' ... WHERE id = ? AND status = 'pending'` — an atomic CAS — before the patch batch sets `status = 'applied'`. The claim, not the batch, is the approve guard.

The property: one proposal's patches are applied at most once, even if two approvals overlap. The harm is a second apply writing the same fact change again.

The check is a bounded explicit-state search of the read and decide write for two approvers and one proposal. Java is not installed here, so TLC is not the runner. The search reads `decideProposal` and turns two source facts into transitions: whether `if (row.status !== "pending")` is present, and whether the claim `UPDATE` requires `status = 'pending'`. It does not execute D1. Local workerd can serialize statements; a green `pnpm test` does not close this window.

## Run

From the repo root:

```bash
node .agents/skills/verify-proposal-decided-once/check.mjs
```

Exit 0 means every explored state applied the patches at most once. Exit 1 prints one shortest trace per finding. Exit 2 means `decideProposal` or the applied `UPDATE` could not be read.

## How to read a failure

- `overlap-read`: both approvers select `pending` before either claim runs, then both apply. The claim UPDATE is what closes this — if it appears, the claim lost its `status = 'pending'` guard.
- `write-after-decided`: an approver continues after `SELECT` already saw `applied`. That appears when the pending fast-path guard is gone — cosmetic on its own, but check the claim guard too.

A new finding, or `overlap-read` after an edit that kept the claim conditional, means this skill no longer matches the function. Re-read `decideProposal` before moving the sync commit.

## Coverage

Checked at commit `a0057400b49b08fdadc30ee5b22ecd99805db2bc`.

Covers `decideProposal` only: the pending read, the claim UPDATE, and the apply batch, two concurrent approvers, one proposal id. It does not cover reject, `validatePatch`, a failed batch or claim release, different proposals, or rate limits.

When `maintain.ts` changes after that commit, run this command again. Move the sync commit only after the traces still describe the function at the new commit.

## Current result

The claim `UPDATE` is conditional on `status = 'pending'`, so the result is pass — a second approver's claim matches zero rows and returns `already_decided`. If the check reports `overlap-read` again, the claim lost its status guard or disappeared; re-read `decideProposal` rather than assuming a checker bug. For the reject side and the recovery obligation of a held claim, `verify-proposal-lifecycle` is the wider model.
