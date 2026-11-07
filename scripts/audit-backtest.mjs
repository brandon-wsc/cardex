#!/usr/bin/env node
// audit-backtest.mjs — advisory backtest for a Jev-based error-handling audit.
// Not part of CI. Scores each catch/.catch() candidate in the tree (plus
// hand-built mutations of them) with OpenRouter's Decisions API, then prints
// the precision/recall table used to pick a warning threshold.
//
// Usage:
//   node scripts/audit-backtest.mjs scan          # list candidates, write labels file
//   node scripts/audit-backtest.mjs run           # score labeled candidates (needs OPENROUTER_API_KEY)
//   node scripts/audit-backtest.mjs run --prs N   # also replay the last N merged PRs (noise count only)

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
// mcp-worker pins TypeScript 7 (native binary, no JS API); the site package
// carries 6.0.3 which still exposes createSourceFile. Parse-only, so either
// would do — resolve from site.
const SITE_PKG = resolve(ROOT, "packages/site/package.json");
const requireFromSite = createRequire(SITE_PKG);
const ts = requireFromSite("typescript");

const OUT_DIR = resolve(ROOT, "scripts/out");
const LABELS_PATH = resolve(ROOT, "scripts/audit-backtest-labels.json");
const RESULTS_PATH = resolve(OUT_DIR, "audit-backtest-results.csv");
const RULE_PATH = resolve(ROOT, "docs/audit-rules.md");

const SCAN_DIRS = ["packages/mcp-worker/src"];
const MODEL = "jev-1.14";
const RUNS = 3; // repeat calls per variant — stability signal

// TypeSafe direct first (no geo gate); OpenRouter fallback is geo-restricted
// for some regions — it 403s before reaching TypeSafe. The OpenRouter key
// may arrive as OPENROUTER_API_KEY or OPENAI_API_KEY — the repo stores it
// under OPENAI_API_KEY (same convention as graphify-semantic.yml, which
// points the OpenAI-compatible base URL at OpenRouter).
const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
const API =
  process.env.TYPESAFE_API_KEY != null
    ? {
        url: "https://api.typesafe.ai/v1/systemone",
        key: process.env.TYPESAFE_API_KEY,
      }
    : {
        url: "https://openrouter.ai/api/alpha/decisions",
        key: OPENROUTER_KEY,
        model: `typesafe/${MODEL}`,
      };

// Manually applied to the extracted function text; each becomes a known-bad
// sample. The patch must match the candidate function verbatim.
const MUTATIONS = [
  {
    base: "packages/mcp-worker/src/access.ts:89",
    find: `.catch(() => false);`,
    replace: `.catch(() => true);`,
    note: "crypto verify throws → signature treated as valid (fail-open auth)",
  },
  {
    base: "packages/mcp-worker/src/access.ts:47",
    find: `  } catch {
    return null;
  }`,
    replace: `  } catch {
    return {} as T;
  }`,
    note: "malformed JWT segment → empty object passes through parse",
  },
  {
    base: "packages/mcp-worker/src/maintain.ts:569",
    find: `return fail("apply_failed", e instanceof Error ? e.message : String(e));`,
    replace: `return { ok: true as const, status: "applied" };`,
    note: "failed db.batch → proposal reported applied with nothing written",
  },
  {
    // Deliberately ambiguous: unparseable → "not illustrative" is a
    // conservative-leaning mark, not a permissive bypass. Backtest showed Jev
    // scores it ~0.2 — keep it as a labeled ok boundary case.
    base: "packages/mcp-worker/src/query.ts:29",
    label: "ok",
    find: `  } catch {
    return true;
  }`,
    replace: `  } catch {
    return false;
  }`,
    note: "unparseable source_url → marked non-illustrative",
  },
  {
    base: "packages/mcp-worker/src/query.ts:65",
    find: `  } catch {
    return false;
  }`,
    replace: `  } catch {
    return true;
  }`,
    note: "unparseable URL → treated as http(s); javascript: bypass reopens",
  },
];

const QUESTIONS = {
  noul_generic: {
    type: "noul",
    instructions: "Does this code swallow an error?",
    criteria: {
      true: "An exception or failure is caught and the code continues as if the operation succeeded, returning a fake success, empty, or default value, or silently ignoring the error.",
      false: "The error is rethrown, converted into an explicit error result the caller must handle, or returning a default is the documented correct behavior.",
    },
  },
  noul_narrow: {
    type: "noul",
    instructions:
      "When the operation in the try block or promise fails, does the code hand the caller a value that lets it continue as though the operation succeeded?",
    criteria: {
      true: "On failure the caller receives a success-shaped or default value and cannot tell the operation failed.",
      false: "On failure the error propagates, becomes an explicit error result, or the default is a conservative rejection (e.g. a validator returning false).",
    },
  },
  noul_rule: {
    type: "noul",
    instructions:
      "Apply rule ERR-01 to the catch handler: catching an exception or a rejected promise is only legitimate when it (a) rethrows or wraps it as an explicit error result, or (b) substitutes a conservative default that cannot make an invalid, unauthenticated, or failed input look valid. Does this handler violate ERR-01?",
    criteria: {
      true: "The handler returns a permissive default, a fabricated success, or discards the error so the caller proceeds as if the operation succeeded.",
      false: "The handler rethrows, returns an explicit failure the caller must handle, or substitutes a conservative rejection (returning false from a validator, null that the caller turns into a 4xx, or a retry).",
    },
  },
};

// --- candidate extraction ---------------------------------------------------

function tsFiles(dir) {
  const out = execFileSync("git", ["ls-files", `${dir}/*.ts`], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((f) => f && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
  return out;
}

function isFunctionNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function functionName(fn) {
  if (fn.name) return fn.name.getText();
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name))
    return fn.parent.name.getText();
  if (ts.isPropertyAssignment(fn.parent) && ts.isIdentifier(fn.parent.name))
    return fn.parent.name.getText();
  return "<anonymous>";
}

function findCandidates(relPath) {
  const abs = resolve(ROOT, relPath);
  const source = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node, enclosing) => {
    const fn = isFunctionNode(node) ? node : enclosing;
    if (ts.isCatchClause(node)) {
      found.push({ node, enclosing: fn, kind: "catch" });
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      found.push({ node, enclosing: fn, kind: ".catch" });
    }
    ts.forEachChild(node, (child) => visit(child, fn));
  };
  ts.forEachChild(sf, (n) => visit(n, null));
  return found.map(({ node, enclosing, kind }) => {
    const { line } = ts.getLineAndCharacterOfPosition(sf, node.getStart());
    const scopeNode = enclosing ?? sf;
    const scopeText = scopeNode.getText(sf);
    const fnName = enclosing ? functionName(enclosing) : "<module>";
    return {
      id: `${relPath}:${line + 1}`,
      file: relPath,
      line: line + 1,
      kind,
      fnName,
      fnText: scopeText,
      fileText: source,
    };
  });
}

function callersOf(cand) {
  if (cand.fnName === "<module>" || cand.fnName === "<anonymous>") return "";
  const sf = ts.createSourceFile(
    cand.file,
    cand.fileText,
    ts.ScriptTarget.Latest,
    true,
  );
  const enclosing = [];
  const seen = new Set();
  const visit = (node, enclosingFn) => {
    const fn = isFunctionNode(node) ? node : enclosingFn;
    if (
      ts.isIdentifier(node) &&
      node.text === cand.fnName &&
      fn &&
      fn.getText(sf) !== cand.fnText &&
      !cand.fnText.includes(fn.getText(sf)) && // not inside the candidate itself
      !seen.has(fn)
    ) {
      seen.add(fn);
      enclosing.push({ name: functionName(fn), text: fn.getText(sf) });
    }
    ts.forEachChild(node, (c) => visit(c, fn));
  };
  ts.forEachChild(sf, (n) => visit(n, null));
  return enclosing
    .map((c) => `--- caller ${c.name} ---\n${c.text}`)
    .join("\n\n");
}

// --- Jev ---------------------------------------------------------------------

async function jev(state, questions) {
  if (!API.key)
    throw new Error(
      "set TYPESAFE_API_KEY (direct) or OPENROUTER_API_KEY / OPENAI_API_KEY",
    );
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: API.model ?? MODEL,
        state,
        questions,
      }),
    });
    if (res.ok) return await res.json();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`decisions ${res.status}: ${await res.text()}`);
  }
  throw new Error("decisions: retries exhausted");
}

// --- scoring variants --------------------------------------------------------

const ruleText = existsSync(RULE_PATH) ? readFileSync(RULE_PATH, "utf8") : "";

function stateVariants(cand) {
  const header = `File: ${cand.file}\nEnclosing scope (${cand.fnName}):\n`;
  const callers = callersOf(cand);
  const fn = header + cand.fnText;
  const withCallers =
    fn +
    "\n\n--- rest of file ---\n" +
    cand.fileText +
    (callers ? `\n\n${callers}` : "");
  return {
    fn,
    callers: withCallers,
    rule: withCallers + `\n\n--- audit rules ---\n${ruleText}`,
  };
}

const fmt = (n) => (n == null ? "" : n.toFixed(2));

async function scoreCandidate(cand, label) {
  const variants = stateVariants(cand);
  const row = { id: cand.id, label };
  const raw = [];
  let cost = 0;
  for (const [vname, state] of Object.entries(variants)) {
    for (const [qname, question] of Object.entries(QUESTIONS)) {
      const probs = [];
      for (let r = 0; r < RUNS; r++) {
        const res = await jev(state, { q: question });
        probs.push(res.answers.q.noul);
        cost += res.usage?.cost ?? 0;
        raw.push({ variant: vname, question: qname, run: r, res });
      }
      const mean = probs.reduce((a, b) => a + b) / probs.length;
      const sd = Math.sqrt(
        probs.reduce((a, b) => a + (b - mean) ** 2, 0) / probs.length,
      );
      row[`p_${vname}_${qname}`] = mean;
      row[`sd_${vname}_${qname}`] = sd;
    }
    process.stderr.write(`  ${cand.id} ${vname} done\n`);
  }
  row.cost = cost;
  row._raw = raw;
  return row;
}

function prTable(rows) {
  const cols = Object.keys(rows[0] ?? {}).filter((k) => k.startsWith("p_"));
  for (const col of cols) {
    const labeled = rows.filter(
      (r) => r.label === "ok" || r.label === "bad" || r.label === "mut",
    );
    const scored = labeled.map((r) => ({
      p: r[col],
      bad: r.label === "bad" || r.label === "mut",
    }));
    let line = `${col}\n`;
    for (let t = 0.3; t <= 0.95; t += 0.05) {
      const tp = scored.filter((s) => s.bad && s.p >= t).length;
      const fp = scored.filter((s) => !s.bad && s.p >= t).length;
      const fn = scored.filter((s) => s.bad && s.p < t).length;
      const prec = tp + fp ? tp / (tp + fp) : NaN;
      const rec = tp + fn ? tp / (tp + fn) : NaN;
      line += `  t=${t.toFixed(2)}  precision=${fmt(prec)}  recall=${fmt(rec)}  warn=${tp + fp}\n`;
    }
    console.log(line);
  }
}

// --- subcommands -------------------------------------------------------------

function cmdScan() {
  const files = SCAN_DIRS.flatMap(tsFiles);
  const all = files.flatMap(findCandidates);
  mkdirSync(OUT_DIR, { recursive: true });
  const labels = all.map((c) => ({ id: c.id, fnName: c.fnName, label: "?" }));
  writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2) + "\n");
  console.log(`${all.length} candidates → ${relative(ROOT, LABELS_PATH)}`);
  for (const c of all) console.log(`  ${c.id}  ${c.kind}  in ${c.fnName}`);
  console.log("Fill in labels (ok|bad|skip) then run: node scripts/audit-backtest.mjs run");
}

function mutate(candidate) {
  const m = MUTATIONS.find((mu) => mu.base === candidate.id);
  if (!m) return null;
  if (!candidate.fnText.includes(m.find)) {
    console.warn(`mutation ${m.base}: find string not in extracted scope — skipped`);
    return null;
  }
  return {
    ...candidate,
    id: `${candidate.id}#mut`,
    fnText: candidate.fnText.replace(m.find, m.replace),
    note: m.note,
  };
}

async function cmdRun(prCount) {
  const files = SCAN_DIRS.flatMap(tsFiles);
  const all = files.flatMap(findCandidates);
  if (!existsSync(LABELS_PATH)) {
    console.error("no labels file — run `node scripts/audit-backtest.mjs scan` first");
    process.exit(1);
  }
  const labels = new Map(
    JSON.parse(readFileSync(LABELS_PATH, "utf8")).map((l) => [l.id, l.label]),
  );
  const rows = [];
  for (const cand of all) {
    const label = labels.get(cand.id) ?? "?";
    if (label === "skip") continue;
    rows.push(await scoreCandidate(cand, label));
    const mut = mutate(cand);
    if (mut) rows.push(await scoreCandidate(mut, mut.label ?? "mut"));
  }
  if (prCount > 0) rows.push(...(await replayPrs(prCount)));

  mkdirSync(OUT_DIR, { recursive: true });
  const cols = [
    "id",
    "label",
    ...[...new Set(rows.flatMap(Object.keys))].filter(
      (k) => k.startsWith("p_") || k.startsWith("sd_"),
    ),
    "cost",
  ];
  const csv = [
    cols.join(","),
    ...rows.map((r) =>
      cols.map((c) => (typeof r[c] === "number" ? fmt(r[c]) : (r[c] ?? ""))).join(","),
    ),
  ].join("\n");
  writeFileSync(RESULTS_PATH, csv + "\n");
  writeFileSync(
    resolve(OUT_DIR, "audit-backtest-raw.json"),
    JSON.stringify(
      rows.map(({ _raw, ...r }) => ({ ...r, raw: _raw })),
      null,
      2,
    ) + "\n",
  );
  for (const r of rows) delete r._raw;
  console.log(`\n${rows.length} rows → ${relative(ROOT, RESULTS_PATH)}`);
  console.log(`total cost: $${rows.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(4)}`);
  prTable(rows.filter((r) => !r.id.startsWith("PR#")));
}

async function replayPrs(n) {
  const prs = JSON.parse(
    execFileSync(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", String(n), "--json", "number,title"],
      { cwd: ROOT, encoding: "utf8" },
    ),
  );
  const rows = [];
  for (const pr of prs) {
    const diff = execFileSync(
      "gh",
      ["api", `repos/{owner}/{repo}/pulls/${pr.number}`, "-H", "Accept: application/vnd.github.diff"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    let file = "";
    let hunk = [];
    const flush = async () => {
      if (!hunk.length) return;
      const added = hunk.filter((l) => l.startsWith("+")).join("\n");
      if (!/catch\s*(\(|\{)|\.catch\(/.test(added)) return;
      const state = `File: ${file}\nAdded in PR #${pr.number} (${pr.title}):\n${hunk.join("\n")}`;
      const row = { id: `PR#${pr.number} ${file}`, label: "?" };
      const res = await jev(state, QUESTIONS);
      for (const q of Object.keys(QUESTIONS)) row[`p_pr_${q}`] = res.answers[q].noul;
      row.cost = res.usage?.cost ?? 0;
      row._raw = [{ variant: "pr", res }];
      rows.push(row);
    };
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git")) {
        await flush();
        hunk = [];
        file = line.replace(/^diff --git a\/\S+ b\//, "");
      } else if (line.startsWith("@@")) {
        await flush();
        hunk = [line];
      } else if (hunk.length && /^[ +\-]/.test(line)) {
        hunk.push(line);
      }
    }
    await flush();
    console.log(`PR #${pr.number}: ${rows.length} catch-hunks so far`);
  }
  return rows;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "scan") {
  cmdScan();
} else if (cmd === "run") {
  const i = args.indexOf("--prs");
  const prs = i >= 0 ? Number(args[i + 1]) : 0;
  await cmdRun(prs);
} else {
  console.log("usage: node scripts/audit-backtest.mjs scan|run [--prs N]");
}
