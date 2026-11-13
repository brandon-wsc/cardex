import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const maintainPath = fileURLToPath(
  new URL("../../../packages/mcp-worker/src/maintain.ts", import.meta.url),
);
const source = readFileSync(maintainPath, "utf8");
const start = source.indexOf("export async function decideProposal");
const end = source.indexOf("\nexport ", start + 1);
if (start < 0) {
  console.error(`decideProposal not found in ${maintainPath}`);
  process.exit(2);
}
const body = source.slice(start, end === -1 ? source.length : end);
const guard = body.includes('if (row.status !== "pending")');
const applied = body.match(/UPDATE proposals SET status = 'applied'[\s\S]*?WHERE [^`]+/);
if (!applied) {
  console.error("applied UPDATE not found in decideProposal");
  process.exit(2);
}
const conditionalApprove = /status\s*=\s*'pending'/.test(applied[0]);

const broken = (state) => state.applies > 1;

function read(state, actor, trace) {
  const sees = state.status;
  const proceeds = !guard || sees === "pending";
  const step = proceeds
    ? `${actor} SELECT status and sees ${sees}, then continues toward the batch`
    : `${actor} SELECT status and sees ${sees}; the pending guard returns already_decided`;
  return {
    state: { ...state, [actor]: proceeds ? "hold" : "idle" },
    trace: [...trace, step],
  };
}

function write(state, actor, trace) {
  if (conditionalApprove && state.status !== "pending") {
    return {
      state: { ...state, [actor]: "idle" },
      trace: [
        ...trace,
        `${actor} UPDATE ... WHERE id = ? AND status = 'pending' matches 0 rows`,
      ],
    };
  }
  return {
    state: { ...state, status: "applied", applies: state.applies + 1, [actor]: "idle" },
    trace: [
      ...trace,
      `${actor} runs the patch batch and sets status = 'applied' with WHERE id = ?`,
    ],
  };
}

function steps(state, trace) {
  const out = [];
  for (const actor of ["A", "B"]) {
    if (state[actor] === "idle") out.push(read(state, actor, trace));
    if (state[actor] === "hold") out.push(write(state, actor, trace));
  }
  return out;
}

const classes = new Map();
const seen = new Set();
const queue = [
  {
    state: { status: "pending", applies: 0, A: "idle", B: "idle" },
    trace: [],
  },
];
while (queue.length > 0) {
  const current = queue.shift();
  const key = JSON.stringify(current.state);
  if (seen.has(key)) continue;
  seen.add(key);
  if (broken(current.state)) {
    const kind = current.trace.some((step) => step.includes("sees applied, then continues"))
      ? "write-after-decided"
      : "overlap-read";
    if (!classes.has(kind)) classes.set(kind, current.trace);
    continue;
  }
  queue.push(...steps(current.state, current.trace));
}

console.log(`source: ${maintainPath}`);
console.log(`pending guard: ${guard}`);
console.log(`approve update conditional on pending: ${conditionalApprove}`);
console.log("property: a proposal's patches are applied at most once");
if (classes.size === 0) {
  console.log("result: pass");
  process.exit(0);
}
for (const [kind, trace] of classes) {
  console.log(`finding ${kind}`);
  trace.forEach((step, i) => console.log(`${i + 1}. ${step}`));
}
console.log("result: fail");
process.exit(1);
