# AI-assisted workflow

> Stub. Full writeup to follow.

This repo is built by coding agents against the conventions in [AGENTS.md](../AGENTS.md). Working notes so far:

- Docs are the contract: PRD, ADRs, and STATUS are updated *before or with* code, not after.
- Every commit is Conventional Commits (`type(scope): summary`, ASCII subject); branches follow Conventional Branch (`feat/…`, `fix/…`, `chore/…`).
- The prototype check is a scripted MCP client (`pnpm demo`), not a test runner — see [TESTING.md](./TESTING.md).
- Dependencies are pinned; `.npmrc` refuses releases younger than 7 days, so the newest available version is often not the one installed.
