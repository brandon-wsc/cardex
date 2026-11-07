// Shared helpers for the Jev audit tooling (backtest + PR gate).
// Candidate extraction walks the TS AST; scoring calls the Decisions
// endpoint — TypeSafe direct when TYPESAFE_API_KEY is set, otherwise
// OpenRouter (which is egress-geo-gated but fine on GH runners).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");

// mcp-worker pins TypeScript 7 (native binary, no JS API); the site package
// carries 6.0.3 which still exposes createSourceFile. Parse-only, so either
// would do — resolve from site.
const requireFromSite = createRequire(
  resolve(ROOT, "packages/site/package.json"),
);
export const ts = requireFromSite("typescript");

export const MODEL = "jev-1.14";

// TypeSafe direct first (no geo gate); OpenRouter fallback is geo-restricted
// for some regions — it 403s before reaching TypeSafe.
// The OpenRouter key may arrive as OPENROUTER_API_KEY or OPENAI_API_KEY —
// the repo stores it under OPENAI_API_KEY (same convention as
// graphify-semantic.yml, which points the OpenAI base URL at OpenRouter).
const openrouterKey =
  process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
export const API = process.env.TYPESAFE_API_KEY
  ? {
      url: "https://api.typesafe.ai/v1/systemone",
      key: process.env.TYPESAFE_API_KEY,
    }
  : {
      url: "https://openrouter.ai/api/alpha/decisions",
      key: openrouterKey,
      model: `typesafe/${MODEL}`,
    };

export async function jev(state, questions) {
  if (!API.key)
    throw new Error("set TYPESAFE_API_KEY (direct) or OPENROUTER_API_KEY");
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

// Finds every `catch` clause and `.catch()` callback in a source file, plus
// the enclosing function it sits in (or the whole module when at top level).
export function findCandidates(relPath) {
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
    const scopeNode = enclosing ?? sf;
    const { line } = ts.getLineAndCharacterOfPosition(sf, node.getStart());
    const { line: fnStart } = ts.getLineAndCharacterOfPosition(
      sf,
      scopeNode.getStart(),
    );
    const { line: fnEnd } = ts.getLineAndCharacterOfPosition(
      sf,
      scopeNode.getEnd(),
    );
    const fnName = enclosing ? functionName(enclosing) : "<module>";
    return {
      id: `${relPath}:${line + 1}`,
      file: relPath,
      line: line + 1,
      kind,
      fnName,
      fnStart: fnStart + 1,
      fnEnd: fnEnd + 1,
      nodeText: node.getText(sf),
      fnText: scopeNode.getText(sf),
      fileText: source,
    };
  });
}

// Same-file call sites of the candidate's enclosing function — extra context
// for judging whether a null/false fallback is safe downstream.
export function callersOf(cand) {
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
