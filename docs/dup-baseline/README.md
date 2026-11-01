# Duplication baseline

`baseline.md` is the checked-in [jscpd](https://github.com/kucherenko/jscpd)
baseline for `packages/mcp-worker/src/**/*.{ts,tsx}`; `jscpd-report.json` is
the machine-readable form. Regenerate both with `pnpm dup` from the repo root
(config: `.jscpd.json`).

Duplication is a review signal, not a hard gate — the job is advisory and no
threshold is enforced yet (TBD once the baseline has a few revisions behind
it). Treat clones as a prompt to look, not a mandate to extract: shared
shape is not always shared behavior, and spec boilerplate is expected to
repeat.
