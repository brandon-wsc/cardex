---
name: verify-proposal-decided-once
description: Checks that decideProposal applies one proposal's patches at most once when two approvals overlap. Use when editing decideProposal, the proposal status guard, or the approve UPDATE in packages/mcp-worker/src/maintain.ts.
---

# Proposal patches apply at most once

`decideProposal` in `packages/mcp-worker/src/maintain.ts` reads `status`, returns `already_decided` unless it is `pending`, then applies every patch and sets `status = 'applied'` in one batch. The read and the batch are separate awaits. The approve `UPDATE` matches `WHERE id = ?` only.

The property: one proposal's patches are applied at most once, even if two approvals overlap. The harm is a second apply writing the same fact change again.

The check is a bounded explicit-state search of those two steps for two approvers and one proposal. Java is not installed here, so TLC is not the runner. The search reads `decideProposal` and turns two source facts into transitions: whether `if (row.status !== "pending")` is present, and whether the applied `UPDATE` also requires `status = 'pending'`. It does not execute D1. Local workerd can serialize statements; a green `pnpm test` does not close this window.

## Run

From the repo root:

```bash
node .agents/skills/verify-proposal-decided-once/check.mjs
```

Exit 0 means every explored state applied the patches at most once. Exit 1 prints one shortest trace per finding. Exit 2 means `decideProposal` or the applied `UPDATE` could not be read.

## How to read a failure

- `overlap-read`: both approvers select `pending` before either batch runs, then both apply. That is the current code.
- `write-after-decided`: an approver continues after `SELECT` already saw `applied`. That appears when the pending guard is gone.

A new finding, or a missing `overlap-read` after an edit that did not make the `UPDATE` conditional, means this skill no longer matches the function. Re-read `decideProposal` before moving the sync commit.

## Coverage

Checked at commit `d0941921ad002a88e9e255205e689358ba5c7792`.

Covers `decideProposal` only: the pending read and the approve batch, two concurrent approvers, one proposal id. It does not cover reject, `validatePatch`, a failed batch rolling back, different proposals, or rate limits.

When `maintain.ts` changes after that commit, run this command again. Move the sync commit only after the traces still describe the function at the new commit.

## Current finding

The guard is present and the approve `UPDATE` is not conditional, so the result is fail with `overlap-read` only. That is a finding in the current function, not a broken checker. Do not delete the finding to make the command exit 0. An `UPDATE` that matches only `pending`, and that ignores a zero-row write, is what removes `overlap-read`.

After a change in this function, read the result with `/maintain-formal-verification-skill` if the covered lines moved and this command was not re-run.
