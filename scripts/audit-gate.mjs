#!/usr/bin/env node
// audit-gate.mjs — advisory PR audit. Finds catch/.catch() candidates in the
// diff, scores them against the rules in docs/audit-rules.md via Jev, and
// reports findings as a GitHub check run with annotations.
//
// Never blocks: the process exits 0 in every case, and the check run
// concludes `neutral` (never `failure`) on findings, missing keys, or API
// errors. Usage: node scripts/audit-gate.mjs <base-sha> <head-sha>

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { findCandidates, jev } from "./lib/audit-common.mjs";

const [BASE, HEAD] = process.argv.slice(2);
if (!BASE || !HEAD) {
  console.error("usage: node scripts/audit-gate.mjs <base-sha> <head-sha>");
  process.exit(1);
}

const SCOPE = /^packages\/[^/]+\/src\/.+\.ts$/;
const SKIP = /\.(test|d)\.ts$|\/demo\.ts$/;
const WARN_AT = 0.8;
const NOTICE_AT = 0.5;
const GUARD_NAME =
  /^(is|has|can|allow|valid|verify|check|access|auth|claims|claimsEmail|parse)/i;
const GUARD_FILE = /access|auth|valid|guard|verify/i;
const ALLOW_RE = /audit-allow\((ERR-\d+|TEST-\d+|\*)\)/g;

// Question text mirrors docs/audit-rules.md verbatim — update both together.
const RULES = {
  "ERR-01": {
    type: "noul",
    instructions:
      "When the operation in the try block or promise fails, does the handler hand the caller a value that lets it continue as though the operation succeeded?",
    criteria: {
      true: "On failure the caller receives a success-shaped result — ok: true, an applied/created status, a populated object fabricated after the failure — and cannot tell the operation failed.",
      false: "The error propagates (rethrow), becomes an explicit error result the caller must handle (fail(...), error enum, thrown Response), or the fallback is a conservative rejection.",
    },
  },
  "ERR-02": {
    type: "noul",
    instructions:
      "In a guard that decides whether input is allowed or trusted, does the exception path return a permissive verdict?",
    criteria: {
      true: "A parse, fetch, or verification failure returns the value that treats the input as valid or trusted (true, the principal, an open decision).",
      false: "The failure returns the denying verdict (false, null the caller turns into a rejection) or propagates as an error. A catch → false/null in a guard is compliant — fail-closed, not a swallowed error.",
    },
  },
  "ERR-03": {
    type: "noul",
    instructions:
      "Is the caught error discarded entirely — no rethrow, no failure result, no fallback value — so execution continues as if the operation never failed?",
    criteria: {
      true: "The handler only logs or is empty, and the function goes on to return a normal result or nothing, hiding that work did not happen.",
      false: "The handler rethrows, returns an error result, supplies a fallback value, or the catch exists to tolerate an already-expected failure (best-effort cleanup, a process that may already be dead).",
    },
  },
};

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function changedFiles() {
  return git("diff", "--name-only", "--diff-filter=AMR", BASE, HEAD)
    .split("\n")
    .filter((f) => SCOPE.test(f) && !SKIP.test(f));
}

// New-side line ranges touched by the diff, per file.
function hunkRanges(file) {
  const diff = git("diff", "--unified=0", BASE, HEAD, "--", file);
  const ranges = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      const start = Number(m[1]);
      const len = Number(m[2] ?? "1");
      if (len > 0) ranges.push([start, start + len - 1]);
    }
  }
  return ranges;
}

function rulesFor(cand) {
  const q = { "ERR-01": RULES["ERR-01"] };
  if (GUARD_NAME.test(cand.fnName) || GUARD_FILE.test(cand.file))
    q["ERR-02"] = RULES["ERR-02"];
  if (!/\b(return|throw)\b/.test(cand.nodeText)) q["ERR-03"] = RULES["ERR-03"];
  const allowed = new Set(
    [...cand.fnText.matchAll(ALLOW_RE)].map((m) => m[1]),
  );
  if (allowed.has("*")) return {};
  for (const id of allowed) delete q[id];
  return q;
}

async function postCheckRun(body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log("no GITHUB_TOKEN/GITHUB_REPOSITORY — check run skipped");
    console.log(JSON.stringify(body.output, null, 2));
    return;
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    console.warn(`check-runs ${res.status}: ${await res.text()} — continuing`);
}

function finish({ conclusion, title, summary, annotations = [] }) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${title}\n\n${summary}\n`,
    );
  return postCheckRun({
    name: "audit-gate",
    head_sha: HEAD,
    status: "completed",
    conclusion,
    output: { title, summary, annotations },
  });
}

async function main() {
  if (process.env.AUDIT_EXEMPT) {
    return finish({
      conclusion: "success",
      title: "audit-gate: exempt",
      summary: "Skipped via the `audit-exempt` label.",
    });
  }
  if (!process.env.TYPESAFE_API_KEY && !process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
    return finish({
      conclusion: "neutral",
      title: "audit-gate: skipped",
      summary:
        "No Jev key available (fork PR or missing secret). Nothing was audited.",
    });
  }

  const files = changedFiles();
  const candidates = files
    .flatMap((f) => {
      const ranges = hunkRanges(f);
      return findCandidates(f).filter((c) =>
        ranges.some(([a, b]) => c.fnStart <= b && c.fnEnd >= a),
      );
    })
    .map((c) => ({ cand: c, questions: rulesFor(c) }))
    .filter(({ questions }) => Object.keys(questions).length > 0);

  console.log(`${candidates.length} catch candidates in ${files.length} changed files`);

  const findings = [];
  const errors = [];
  for (const { cand, questions } of candidates) {
    const state = `File: ${cand.file}\nEnclosing scope (${cand.fnName}):\n${cand.fnText}`;
    let res;
    try {
      res = await jev(state, questions);
    } catch (e) {
      errors.push(`${cand.id}: ${e.message}`);
      continue;
    }
    for (const [ruleId, ans] of Object.entries(res.answers)) {
      const p = ans.noul;
      if (p >= NOTICE_AT)
        findings.push({
          path: cand.file,
          start_line: cand.line,
          end_line: cand.line,
          annotation_level: p >= WARN_AT ? "warning" : "notice",
          title: `audit-gate ${ruleId}`,
          message: `${ruleId} (p=${p.toFixed(2)}): ${RULES[ruleId].instructions}`,
        });
    }
  }

  if (errors.length) {
    return finish({
      conclusion: "neutral",
      title: "audit-gate: unavailable",
      summary: `${errors.length} candidate(s) could not be scored:\n\n${errors.map((e) => `- \`${e}\``).join("\n")}`,
    });
  }
  if (findings.length) {
    const warn = findings.filter((f) => f.annotation_level === "warning").length;
    return finish({
      conclusion: "neutral",
      title: `audit-gate: ${findings.length} finding(s), ${warn} warning`,
      summary:
        "Advisory only — review the annotations and either fix, or exempt with `// audit-allow(ERR-NN): reason`. Findings:",
      annotations: findings,
    });
  }
  return finish({
    conclusion: "success",
    title: "audit-gate: clean",
    summary: `${candidates.length} catch candidate(s) audited, no rule hits.`,
  });
}

main().catch(async (e) => {
  console.warn(`audit-gate crashed: ${e.message}`);
  try {
    await finish({
      conclusion: "neutral",
      title: "audit-gate: unavailable",
      summary: `\`${e.message}\``,
    });
  } finally {
    process.exit(0); // advisory — never block
  }
});
