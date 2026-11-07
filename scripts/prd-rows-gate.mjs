#!/usr/bin/env node
// PRD row ↔ spec gate — mechanizes "one row, one it()" (docs/TESTING.md),
// which the contract gate only approximates ("a *.test.ts moved").
//
// docs/prd-rows.json keys every table row in PRD §4–§6 by its first cell
// (verbatim) and maps it to a substring that must appear in an it()/test()
// title. Three assertions:
//
//   1. Every table row in PRD §4–§6 has an entry — a new row without a
//      spec fails here even when a *.test.ts file moved in the same PR.
//   2. Every entry's key still exists as a row — a deleted or reworded
//      row cannot leave an orphan pointing at a spec that covers nothing.
//   3. Every entry's value is a substring of a spec title — a renamed
//      spec fails the gate.
//
// Bonus: every `pnpm <name>` token in AGENTS.md that is not a pnpm
// builtin must exist as a root package.json script, so documented
// commands cannot rot.
//
// Exit 1 prints ::error:: lines for CI. Run from the repo root.
// usage: node scripts/prd-rows-gate.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const failures = [];

// --- PRD §4–§6 table rows (first cell, verbatim) ---
const prdLines = readFileSync("docs/PRD.md", "utf8").split("\n");
const start = prdLines.findIndex((l) => /^## 4\./.test(l));
const end = prdLines.findIndex((l) => /^## 7\./.test(l));
if (start < 0 || end <= start) {
  console.log("::error::PRD §4/§7 headers not found — cannot enumerate spec rows");
  process.exit(1);
}
const section = prdLines.slice(start, end);
const isSeparator = (l) => /^\s*\|[\s:|-]*-[\s:|-]*\|?\s*$/.test(l);
const rowKeys = new Set();
for (let i = 0; i < section.length; i++) {
  const line = section[i];
  if (!line.trimStart().startsWith("|") || isSeparator(line)) continue;
  if (i + 1 < section.length && isSeparator(section[i + 1])) continue; // header
  const firstCell = line.split("|")[1]?.trim();
  if (!firstCell) continue;
  if (rowKeys.has(firstCell)) {
    failures.push(`duplicate first cell in PRD §4–§6 tables — keys must be unique: "${firstCell}"`);
  }
  rowKeys.add(firstCell);
}

// --- the map ---
const map = JSON.parse(readFileSync("docs/prd-rows.json", "utf8")).rows ?? {};

for (const key of rowKeys) {
  if (!(key in map)) {
    failures.push(`PRD §4–§6 row has no spec mapping in docs/prd-rows.json: "${key}"`);
  }
}
for (const key of Object.keys(map)) {
  if (!rowKeys.has(key)) {
    failures.push(`docs/prd-rows.json key matches no PRD §4–§6 row (deleted or reworded?): "${key}"`);
  }
}

// --- spec titles ---
const testFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") walk(path);
    } else if (name.endsWith(".test.ts")) {
      testFiles.push(path);
    }
  }
})("packages");

// it("…"), it.fails("…"), it.each(CASES)("…"), test.todo("…"), …
const TITLE_RE = /\b(?:it|test)(?:\.[a-zA-Z]+)*(?:\s*\([^()]*\))*\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
const titles = [];
for (const file of testFiles) {
  for (const m of readFileSync(file, "utf8").matchAll(TITLE_RE)) titles.push(m[2]);
}
for (const [key, sub] of Object.entries(map)) {
  if (rowKeys.has(key) && !titles.some((t) => t.includes(sub))) {
    failures.push(`no spec title contains "${sub}" — mapped from PRD row "${key}"`);
  }
}

// --- AGENTS.md pnpm commands exist as scripts ---
const BUILTINS = new Set(
  ("install i add remove rm un uninstall update up upgrade run exec dlx create init publish pack patch " +
    "audit outdated list ls ll la why info view rebuild rb prune link ln unlink import dedupe fetch " +
    "store server root bin env config cache doctor help version licenses self-update deploy " +
    "approve-builds ignored-builds setup").split(" "),
);
const agents = readFileSync("AGENTS.md", "utf8");
const scripts = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {});
for (const m of agents.matchAll(/\bpnpm\s+([a-z][a-z0-9:_-]*)/g)) {
  const cmd = m[1];
  if (!BUILTINS.has(cmd) && !scripts.includes(cmd)) {
    failures.push(`AGENTS.md documents \`pnpm ${cmd}\` but package.json has no "${cmd}" script`);
  }
}

if (failures.length) {
  for (const f of failures) console.log(`::error::${f}`);
  process.exit(1);
}
console.log(`prd rows gate ok — ${rowKeys.size} rows mapped, ${titles.length} spec titles scanned`);
