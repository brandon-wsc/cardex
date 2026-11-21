import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { initSync, check_spec_with_cfg } from "tla-checker";

const require = createRequire(import.meta.url);
const wasmPath = fileURLToPath(
  new URL("./tla_checker_bg.wasm", pathToFileURL(require.resolve("tla-checker"))),
);
initSync({ module: readFileSync(wasmPath) });

const skillDir = fileURLToPath(new URL(".", import.meta.url));
const maintainPath = fileURLToPath(
  new URL("../../../packages/mcp-worker/src/maintain.ts", import.meta.url),
);
const specPath = `${skillDir}ProposalLifecycle.tla`;
const fixedSpecPath = `${skillDir}ProposalLifecycleFixed.tla`;

// source facts:

const source = readFileSync(maintainPath, "utf8");
const start = source.indexOf("export async function decideProposal");
if (start < 0) {
  console.error(`decideProposal not found in ${maintainPath}`);
  process.exit(2);
}
const end = source.indexOf("\nexport ", start + 1);
const body = source.slice(start, end === -1 ? source.length : end);

const guard = body.includes('if (row.status !== "pending")');
// The approve guard is the claim UPDATE ('pending' -> 'approved'), an
// atomic CAS. The final 'applied' UPDATE inside the patch batch runs only
// after the claim won — a status clause there would not gate the patches,
// which land in the same batch.
const claimUpdate = body.match(
  /UPDATE proposals SET status = 'approved'[\s\S]*?WHERE [^`]+/,
);
const appliedUpdate = body.match(
  /UPDATE proposals SET status = 'applied'[\s\S]*?WHERE [^`]+/,
);
const rejectedUpdate = body.match(
  /UPDATE proposals SET status = 'rejected'[\s\S]*?WHERE [^`]+/,
);
const releaseUpdate = body.match(
  /UPDATE proposals SET status = 'pending'[\s\S]*?WHERE [^`]+/,
);
if (!appliedUpdate || !rejectedUpdate) {
  console.error("an applied/rejected UPDATE was not found in decideProposal");
  process.exit(2);
}
const conditionalApprove =
  !!claimUpdate && /status\s*=\s*'pending'/.test(claimUpdate[0]);
const conditionalReject = /status\s*=\s*'pending'/.test(rejectedUpdate[0]);
const releasableClaim =
  !!releaseUpdate && /status\s*=\s*'approved'/.test(releaseUpdate[0]);

// The invariant a finding comes from names the harm in the code's terms.
const FINDING_OF = {
  AtMostOnce: "overlap-read",
  DecisionsFinal: "decision-override",
};

// What the current code shape predicts:
// - an unconditional approve can land a second batch -> overlap-read
// - an unconditional decide write can overwrite a decision already made
//   (reject over 'applied', or approve over 'rejected') -> decision-override
const expected = new Set();
if (!conditionalApprove) expected.add("overlap-read");
if (!conditionalApprove || !conditionalReject)
  expected.add("decision-override");

// Each invariant gets its own run so a violation maps to exactly one finding.

const constants = JSON.stringify({
  Proposals: ["p1", "p2"],
  Approvers: ["a1", "a2"],
  MaxPending: 2,
});
const MAX_STATES = 1_000_000;
const MAX_DEPTH = 200;

function check(specFile, invariants) {
  const spec = readFileSync(specFile, "utf8");
  const cfg = `INIT Init\nNEXT Next\nINVARIANTS ${invariants.join(" ")}`;
  const result = JSON.parse(
    check_spec_with_cfg(spec, cfg, constants, MAX_STATES, MAX_DEPTH, true, false),
  );
  if (result.error_type && result.error_type !== "InvariantViolation") {
    console.error(`checker error on ${specFile}: ${result.error_message}`);
    process.exit(2);
  }
  return result;
}

function parseState(text) {
  const vars = {};
  for (const m of text.matchAll(/(\w+)\s*=\s*\[([^\]]*)\]/g)) {
    const entries = {};
    for (const e of m[2].matchAll(/(\w+)\s*\|->\s*("[^"]*"|[-\w]+)/g))
      entries[e[1]] = e[2].replace(/"/g, "");
    vars[m[1]] = entries;
  }
  return vars;
}

// tla-checker returns the trace as one string per entry, with all states
// inside it — split on the "State N" markers to get one block per state.
function traceStates(trace) {
  const blocks = (trace ?? [])
    .flatMap((t) => t.split(/(?=^State \d+)/m))
    .filter((b) => b.trim() !== "");
  return blocks.map(parseState);
}

function describeStep(prev, next) {
  // patches landing: the applied counter going up is the harm itself —
  // a second apply may not change status (already 'applied')
  for (const p of Object.keys(next.applied ?? {})) {
    if (Number(next.applied[p]) > Number(prev.applied[p]))
      return `approve batch commits: patches apply to ${p}, status -> 'applied' (WHERE id = ?)`;
  }
  for (const p of Object.keys(next.status ?? {})) {
    if (next.status[p] !== prev.status[p]) {
      if (prev.status[p] === "absent" && next.status[p] === "pending")
        return `propose_change inserts ${p} with status 'pending'`;
      if (next.status[p] === "applied")
        return `approve batch commits: patches apply, ${p} status -> 'applied' (WHERE id = ?)`;
      if (next.status[p] === "rejected")
        return `reject UPDATE commits: ${p} status -> 'rejected' (WHERE id = ?)`;
      if (next.status[p] === "approved")
        return `claim UPDATE wins: ${p} status -> 'approved'`;
      if (next.status[p] === "pending")
        return `claim released: ${p} status -> 'pending'`;
      return `${p} status ${prev.status[p]} -> ${next.status[p]}`;
    }
  }
  for (const a of Object.keys(next.pc ?? {})) {
    if (prev.pc[a] === "idle" && next.pc[a] === "decide")
      return `${a} SELECTs status and sees '${next.observed[a]}'`;
    if (prev.pc[a] === "decide" && next.pc[a] === "idle")
      return `${a} reads stale state and writes nothing`;
    if (prev.pc[a] === "decide" && next.pc[a] === "apply")
      return `${a}'s claim UPDATE matched 1 row`;
    if (prev.pc[a] === "apply" && next.pc[a] === "idle")
      return `${a}'s apply step ends`;
  }
  return "state changes";
}

console.log(`source: ${maintainPath}`);
console.log(`pending fast-path guard: ${guard}`);
console.log(`approve claim UPDATE conditional on pending: ${conditionalApprove}`);
console.log(`reject UPDATE conditional on pending: ${conditionalReject}`);
console.log("properties: patches apply at most once; the first decision is final");

if (conditionalApprove !== conditionalReject) {
  console.error(
    "decideProposal has a shape the specs do not model: one decide write is " +
      "conditional, the other is not. Read the function, add a spec variant " +
      "matching it, and re-sync the coverage commit.",
  );
  process.exit(2);
}

if (conditionalApprove) {
  // Both decide writes are conditional — the code claims the fixed shape.
  // That shape includes a way to release a held claim; without one a
  // failed apply wedges the row at 'approved' with no path the spec
  // models back out.
  if (!releasableClaim) {
    console.error(
      "the decide writes are conditional but no claim-release UPDATE " +
        "('approved' -> 'pending') was found — re-read decideProposal " +
        "before moving the sync commit",
    );
    process.exit(2);
  }
  // The fixed model has to prove the conditional writes actually hold.
  const fixed = check(fixedSpecPath, Object.keys(FINDING_OF));
  if (fixed.success) {
    console.log("result: pass");
    process.exit(0);
  }
  console.log("the conditional writes did not make the properties hold:");
  const states = traceStates(fixed.trace);
  states
    .slice(1)
    .forEach((s, i) => console.log(`${i + 1}. ${describeStep(states[i], s)}`));
  console.log("result: fail");
  process.exit(1);
}

// Both decide writes are unconditional — the model of the current code must
// produce exactly the expected findings: no more (a new bug shape), no less
// (the spec drifted away from the function it describes).
const findings = new Map();
for (const invariant of Object.keys(FINDING_OF)) {
  const r = check(specPath, [invariant]);
  if (r.success) continue;
  const states = traceStates(r.trace);
  const steps = states.slice(1).map((s, i) => describeStep(states[i], s));
  findings.set(FINDING_OF[invariant], steps);
}

// The fixed spec is the verified target shape for the fix — it must keep
// passing so the path out of the findings stays proven.
const fixed = check(fixedSpecPath, Object.keys(FINDING_OF));
if (!fixed.success) {
  console.error(
    "the fixed-shape spec no longer verifies — the checker or the spec regressed",
  );
  process.exit(2);
}

const produced = new Set(findings.keys());
const missing = [...expected].filter((f) => !produced.has(f));
if (missing.length > 0) {
  console.log(
    `expected finding(s) not produced by the model: ${missing.join(", ")}`,
  );
  console.log(
    "the spec may no longer describe decideProposal — re-read it and re-sync",
  );
  process.exit(2);
}

for (const kind of produced) {
  const marker = expected.has(kind) ? "finding" : "NEW finding";
  console.log(`${marker} ${kind}`);
  findings.get(kind).forEach((s, i) => console.log(`${i + 1}. ${s}`));
}
if (produced.size === 0) {
  console.log("result: pass");
  process.exit(0);
}
console.log("result: fail");
process.exit(1);
