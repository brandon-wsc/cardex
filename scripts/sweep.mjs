#!/usr/bin/env node
// sweep.mjs — periodic full-tree hygiene sweep (cheap model).
// Partitions src files, runs a fixed rule checklist per file, fingerprints
// findings, dedups against open `auto-sweep` issues, files new ones and
// closes resolved ones. Findings are UNVERIFIED candidates — verification
// is human + strong model, per the escape-loop design.
//
// Env:
//   OPENROUTER_API_KEY (or SWEEP_API_KEY) — required
//   SWEEP_MODEL      — default deepseek/deepseek-v4.1-flash
//   SWEEP_FILES      — comma-separated paths to limit scope (testing)
//   SWEEP_MAX_ISSUES — max new issues per run (default 5)
//   SWEEP_DRY=1      — print findings + issue plan, touch nothing
//   GITHUB_TOKEN + GITHUB_REPOSITORY — needed to file/close issues;
//                      without them the run prints the plan instead

import { createHash } from "node:crypto";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MODEL = process.env.SWEEP_MODEL ?? "deepseek/deepseek-v4.1-flash";
const API_KEY = process.env.SWEEP_API_KEY ?? process.env.OPENROUTER_API_KEY;
const MAX_ISSUES = Number(process.env.SWEEP_MAX_ISSUES ?? 5);
const DRY = !!process.env.SWEEP_DRY;
const LABEL = "auto-sweep";
const FULL_RUN = !process.env.SWEEP_FILES;

// Narrow checks — each is one question, anchored per-file so non-catch
// shapes are covered too. Rules map to the repo's locked boundaries
// (ADRs), not generic style. Rules that become scriptable get promoted
// out of this list to a deterministic gate — see telemetry-sink.
const RULES = [
  {
    id: "ERR-SWALLOW",
    text: "A failure path produces a success-shaped result the caller cannot distinguish from real success: empty/log-only catch, catch→constant return, a status/outcome mapping that routes errors to ok-looking values, or an inspection failure that downgrades to 'no error'.",
  },
  {
    id: "ERR-GUARD",
    text: "A guard deciding whether input is allowed or trusted returns a permissive verdict when verification itself fails (parse error, missing row, unreadable count → allowed).",
  },
  {
    id: "AUTH-OPEN",
    text: "An auth or identity check fails open when a secret or config is absent, or trusts caller-set headers for identity. Do not report designs the repo documents as intentional (e.g. the x-cardex-probe self-tag is declared forgeable-by-design in ADR 0016).",
  },
  {
    id: "BOUND-PUBLIC",
    text: "On the public /mcp surface only: caller-controlled size drives unbounded work — array length, string length, page size with no cap. Admin and maintainer surfaces are owner-only, out of scope. Inputs already capped elsewhere (zod .max, applyLimit clamps, the 4 MiB body cap) do not count.",
  },
  {
    id: "BOUNDARY-FACTS",
    text: "A tool response violates the product boundary: returns the whole catalog instead of a filtered page, or names/recommends a 'best' card instead of returning facts under caller assumptions.",
  },
  {
    id: "STATE-RACE",
    text: "Module-global mutable state written per-request — shared across concurrent requests in one isolate, so requests can leak into each other (counters, current-request variables, caches keyed by nothing).",
  },
  {
    id: "ERROR-DISCLOSURE",
    text: "Internals reaching the public response: SQL/D1 error text, stack traces, env variable names, file paths, or upstream error payloads forwarded to unauthenticated callers.",
  },
];

const SKIP = /\.(test|d)\.ts$|\/demo\.ts$/;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) yield* walk(p);
    } else if (e.name.endsWith(".ts") && !SKIP.test(p)) {
      yield p;
    }
  }
}

function filesToScan() {
  if (process.env.SWEEP_FILES)
    return process.env.SWEEP_FILES.split(",").map((f) => f.trim());
  const pkgs = join(ROOT, "packages");
  const out = [];
  for (const pkg of readdirSync(pkgs)) {
    const src = join(pkgs, pkg, "src");
    try {
      out.push(...walk(src));
    } catch {
      /* no src dir */
    }
  }
  return out.map((p) => relative(ROOT, p));
}

const PROMPT = `You are a narrow code-review detector. Apply ONLY these rules to the file; report nothing else.

${RULES.map((r, i) => `${i + 1}. ${r.id}: ${r.text}`).join("\n")}

Already enforced elsewhere — never report these:
- Telemetry writes outside src/usage.ts (cardex/telemetry-sink ESLint gate)
- limit params clamped to MAX_LIMIT by applyLimit in query.ts
- Request bodies capped at 4 MiB by the SDK reader
- Money arithmetic through Dec (cardex/money-math rule)

Check inside this file first: if the enforcement a finding assumes missing already exists here, do not report it.

Reply with JSON only, no prose: {"findings":[{"rule":"<id>","line":<line number>,"claim":"<one sentence: what fails and what the bad outcome is>","confidence":<0.0-1.0>}]}.
Report at most 3 findings, highest confidence first. Empty array when nothing applies — a clean file is a valid result. Do not report style, naming, or speculative future risks.`;

async function scan(file) {
  const source = readFileSync(join(ROOT, file), "utf8");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: `File: ${file}\n\`\`\`ts\n${source}\n\`\`\``,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      const parsed = JSON.parse(m[0]);
      return Array.isArray(parsed.findings) ? parsed.findings : [];
    } catch {
      return [];
    }
  }
}

// Stable fingerprint: rule + file + the line's trimmed text (falls back to
// the claim) so renames/shifted lines still mostly match.
function fingerprint(file, f, source) {
  let anchor = String(f.claim ?? "").slice(0, 80);
  const lines = source.split("\n");
  if (Number.isInteger(f.line) && lines[f.line - 1])
    anchor = lines[f.line - 1].trim().slice(0, 80);
  return createHash("sha1")
    .update(`${f.rule}|${file}|${anchor}`)
    .digest("hex")
    .slice(0, 12);
}

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...opts.headers,
    },
  });
  if (!res.ok) throw new Error(`github ${path} ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function openIssues() {
  const issues = await gh(
    `/repos/${process.env.GITHUB_REPOSITORY}/issues?labels=${LABEL}&state=open&per_page=100`,
  );
  return new Map(
    issues.map((i) => [i.body?.match(/sweep-fp: ([0-9a-f]{12})/)?.[1], i]),
  );
}

const issueBody = (file, f, fp) => `**${f.rule}** — \`${file}:${f.line}\`

${f.claim}

> [!NOTE]
> Unverified finding from the weekly cheap-model sweep (${MODEL}). Verify
> with a human + strong model before acting — false positives are expected.
> If wrong or wontfix, close with a comment so the class can be tuned.

Confidence: ${f.confidence ?? "?"}
sweep-fp: ${fp}`;

async function main() {
  if (!API_KEY) {
    console.error("set OPENROUTER_API_KEY or SWEEP_API_KEY");
    process.exit(1);
  }
  const files = filesToScan();
  console.log(`sweep: ${files.length} files, model=${MODEL}`);

  const findings = [];
  for (const file of files) {
    try {
      const found = await scan(file);
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const f of found)
        findings.push({ file, f, fp: fingerprint(file, f, source) });
      if (found.length) console.log(`  ${file}: ${found.length} finding(s)`);
    } catch (e) {
      console.warn(`  ${file}: scan failed — ${e.message}`);
    }
  }

  console.log(`\n${findings.length} total finding(s)`);
  for (const { file, f, fp } of findings)
    console.log(`  [${f.rule}] ${file}:${f.line} (fp=${fp}, c=${f.confidence}) ${f.claim}`);

  const canFile = process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY;
  if (!canFile || DRY) {
    console.log(
      DRY
        ? "\nSWEEP_DRY — issue plan only:"
        : "\nno GITHUB_TOKEN/GITHUB_REPOSITORY — issue plan only:",
    );
    for (const { file, f, fp } of findings.slice(0, MAX_ISSUES))
      console.log(`  would file: ${f.rule} ${file}:${f.line} — ${f.claim}`);
    return;
  }

  const open = await openIssues();
  const current = new Set(findings.map((x) => x.fp));
  const fresh = findings.filter((x) => !open.has(x.fp));

  let filed = 0;
  for (const { file, f, fp } of fresh) {
    if (filed >= MAX_ISSUES) break;
    await gh(`/repos/${process.env.GITHUB_REPOSITORY}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: `sweep: ${f.rule} in ${file}:${f.line}`,
        body: issueBody(file, f, fp),
        labels: [LABEL],
      }),
    });
    filed++;
  }
  console.log(`filed ${filed} new issue(s) (${fresh.length} fresh, capped at ${MAX_ISSUES})`);

  // Auto-close resolved findings — full runs only, so a scoped test never
  // closes issues for files it didn't scan.
  if (FULL_RUN) {
    let closed = 0;
    for (const [fp, issue] of open) {
      if (!fp || current.has(fp)) continue;
      await gh(
        `/repos/${process.env.GITHUB_REPOSITORY}/issues/${issue.number}/comments`,
        { method: "POST", body: JSON.stringify({ body: "Fingerprint absent in the latest sweep — closing as resolved." }) },
      );
      await gh(`/repos/${process.env.GITHUB_REPOSITORY}/issues/${issue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      closed++;
    }
    if (closed) console.log(`closed ${closed} resolved issue(s)`);
  }
}

main()
  .then(() => {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        "### hygiene sweep complete\n",
      );
  })
  .catch((e) => {
    console.error(`sweep crashed: ${e.message}`);
    process.exit(1);
  });
