#!/usr/bin/env node
// Contract gate — mechanizes the two drift rules the repo runs on:
//
//   A. Tool-behavior files do not move without the contract:
//      touching src/query.ts, src/server.ts, or migrations/ requires a
//      docs/PRD.md or docs/adr/ change in the same PR (AGENTS.md —
//      "update the PRD first"). query.ts is the tool-I/O authority,
//      server.ts holds the tool input schemas, migrations/ is the schema.
//
//   B. New PRD behavior rows land with a spec: added table rows in
//      PRD §4–§6 require a touched *.test.ts in the same PR
//      (TESTING.md — "one row, one it()"). Spec names are prose, so this
//      checks that a spec moved, not that it names the row.
//
// Exit 1 prints ::error:: lines for CI. The contract-exempt PR label
// skips the whole gate (handled in ci.yml).
//
// usage: node scripts/contract-gate.mjs <base-sha> <head-sha>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error("usage: node scripts/contract-gate.mjs <base-sha> <head-sha>");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
const failures = [];

const BEHAVIOR = /^packages\/mcp-worker\/(src\/(query|server)\.ts|migrations\/)/;
const CONTRACT_DOCS = /^docs\/(PRD\.md|adr\/)/;

const behavior = changed.filter((f) => BEHAVIOR.test(f));
if (behavior.length && !changed.some((f) => CONTRACT_DOCS.test(f))) {
  failures.push(
    `changed contract surface (${behavior.join(", ")}) without docs/PRD.md or docs/adr/ — ` +
      "update the contract first, or apply the 'contract-exempt' label",
  );
}

if (changed.includes("docs/PRD.md")) {
  const diff = git("diff", "-U0", base, head, "--", "docs/PRD.md");
  const addedRowLines = [];
  let newLine = 0;
  for (const l of diff.split("\n")) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (l.startsWith("-")) continue; // removals leave no new-file line
    if (l.startsWith("+") && !l.startsWith("+++")) {
      if (/^\+\s*\|/.test(l)) addedRowLines.push(newLine);
    }
    newLine++;
  }
  if (addedRowLines.length) {
    // §4 Tools through §6 States — the sections TESTING.md sources specs from
    const prd = readFileSync("docs/PRD.md", "utf8").split("\n");
    const start = prd.findIndex((l) => /^## 4\./.test(l)) + 1;
    const end = prd.findIndex((l) => /^## 7\./.test(l)) + 1;
    if (start > 0 && end > start) {
      const specRows = addedRowLines.filter((n) => n > start && n < end);
      if (specRows.length && !changed.some((f) => /\.test\.ts$/.test(f))) {
        failures.push(
          `PRD §4–§6 gained ${specRows.length} table row(s) but no *.test.ts changed — ` +
            "one row, one it() (TESTING.md), or apply the 'contract-exempt' label",
        );
      }
    } else {
      console.log("::warning::PRD §4/§7 headers not found — spec-row check skipped");
    }
  }
}

if (failures.length) {
  for (const f of failures) console.log(`::error::${f}`);
  process.exit(1);
}
console.log("contract gate ok");
