#!/usr/bin/env node
// Focused run of the cardex/money-math rule (ADR 0011) — the same rule
// pnpm lint enforces, isolated so audits and PR diffs get a clean read.
//
//   node scripts/money-scan.mjs              whole repo (the money-math skill)
//   node scripts/money-scan.mjs --diff REF   files changed vs REF (CI)
//   node scripts/money-scan.mjs --strict-all advisory: typed check on
//                                            every src file — review the
//                                            report, findings do not fail
import { execFileSync } from "node:child_process";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import cardex, { STRICT_GLOBS } from "./eslint-local-rules.mjs";

const args = process.argv.slice(2);
const strictAll = args.includes("--strict-all");
const diffIdx = args.indexOf("--diff");
const flag = diffIdx === -1 ? undefined : "--diff";
const ref = diffIdx === -1 ? undefined : args[diffIdx + 1];
if (args.some((a) => a !== "--strict-all" && a !== "--diff" && a !== ref)) {
  console.error(
    `usage: money-scan.mjs [--diff <git-ref>] [--strict-all] — got ${args.join(" ")}`,
  );
  process.exit(2);
}
if (flag === "--diff" && !ref) {
  console.error("usage: money-scan.mjs --diff <git-ref>");
  process.exit(2);
}

let targets = ["packages"];
if (flag === "--diff") {
  targets = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACM",
      `${ref}...HEAD`,
      "--",
      "*.ts",
      "*.tsx",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.endsWith(".d.ts"));
  if (targets.length === 0) {
    console.log(`money-scan ok — no changed ts/tsx files vs ${ref}`);
    process.exit(0);
  }
}

const eslint = new ESLint({
  overrideConfigFile: true,
  baseConfig: [
    {
      // Generated declarations and vendored trees are not reviewed code.
      ignores: ["**/*.d.ts", "**/node_modules/**", "**/dist/**"],
    },
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: { parser: tseslint.parser },
      plugins: { cardex },
      // Other rules' disables are out of scope for a focused scan.
      linterOptions: { reportUnusedDisableDirectives: "off" },
      rules: { "cardex/money-math": "error" },
    },
    {
      // Money modules are type-checked — the scanner must build the same
      // program pnpm lint builds, scoped to strict files only.
      files: STRICT_GLOBS,
      languageOptions: {
        parserOptions: { projectService: true },
      },
    },
    ...(strictAll
      ? [
          {
            // Advisory wide net: typed check across package src. Every
            // file lives under a package tsconfig, so projectService is
            // safe here. Findings are for triage, not gating.
            files: ["packages/*/src/**/*.{ts,tsx}"],
            languageOptions: {
              parserOptions: { projectService: true },
            },
            rules: {
              "cardex/money-math": ["error", { strictAll: true }],
            },
          },
        ]
      : []),
  ],
});

const results = await eslint.lintFiles(targets);
const formatter = await eslint.loadFormatter("stylish");
const output = await formatter.format(results);
const errors = results.reduce((n, r) => n + r.errorCount, 0);
if (output.trim()) console.log(output.trimEnd());
if (strictAll) {
  console.log(
    errors > 0
      ? `money-scan --strict-all: ${errors} candidate(s) — triage each: money → Dec/STRICT_FILE, noise → reasoned suppress or allowlist`
      : "money-scan --strict-all ok — no computed-number arithmetic found",
  );
  process.exit(0);
}
if (errors > 0) {
  console.error(
    `money-scan: ${errors} finding(s) — money math goes through Dec ` +
      "(packages/mcp-worker/src/decimal.ts). See .agents/skills/money-math.",
  );
  process.exit(1);
}
console.log(`money-scan ok — ${results.length} file(s) checked`);
