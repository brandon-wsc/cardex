import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// Post-deploy / scheduled smoke check against a deployed Worker (TESTING.md
// tier "Smoke"). Hard checks gate; search_terms only warns because
// search_unavailable is a legal degraded state (ADR 0014). Every request
// carries x-cardex-probe so usage counters bucket it as self-traffic
// (ADR 0016 decision 5 — all owner health checks send it).
//
// Assertions are shape-only on facts (records non-empty) but exact on the
// contract (the tool-name set): facts change via the proposal loop, the
// tool surface does not.

const BASE = (
  process.argv[2] ??
  process.env.CARDEX_SMOKE_URL ??
  "https://cardex.brandonhk.com"
).replace(/\/$/, "");

const PROBE = { headers: { "x-cardex-probe": "1" } };

// Loopback targets get a dev identity automatically (DEV_ADMIN_EMAIL in
// .dev.vars), so a 200 on /admin is intentional there, not an Access hole —
// warn instead of fail. On any real hostname 200 always means a hole.
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/.test(
  new URL(BASE).hostname,
);

const EXPECTED_TOOLS = [
  "get_card",
  "get_term",
  "list_tags",
  "lookup_rates",
  "report_issue",
  "resolve_alias",
  "score_candidates",
  "search_terms",
];

let failures = 0;
const pass = (name: string, note = "") =>
  console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
const fail = (name: string, note = "") => {
  failures += 1;
  console.error(`FAIL ${name}${note ? ` — ${note}` : ""}`);
};
const warn = (name: string, note = "") =>
  console.warn(`WARN ${name}${note ? ` — ${note}` : ""}`);
const adminCheck = LOOPBACK ? warn : fail;

// An unreachable host reports FAIL per check rather than crashing on the
// first refused connection.
async function probe(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`, { ...init, ...PROBE });
  } catch {
    return null;
  }
}
const describe = (res: Response | null) =>
  res ? `status ${res.status}` : "unreachable";

// L0 — site assets served.
const home = await probe("/", { redirect: "manual" });
if (home?.status === 200) pass("GET /");
else fail("GET /", describe(home));

// L3 — auth surfaces fail closed. /maintainer rejects with 401 when
// MAINTAINER_TOKEN is configured and 404 when it is not; either way the
// MCP handler must not answer. /admin must not serve the portal: Access
// redirects (3xx) or the Worker 401s (ADR 0008) — 200 means a hole.
const maintainer = await probe("/maintainer");
if (maintainer?.status === 401 || maintainer?.status === 404) {
  pass("GET /maintainer unauthenticated", describe(maintainer));
} else {
  fail("GET /maintainer unauthenticated", describe(maintainer));
}

for (const path of ["/admin", "/admin/api/me"]) {
  const res = await probe(path, { redirect: "manual" });
  if (res?.status === 200) {
    adminCheck(
      `GET ${path} unauthenticated`,
      LOOPBACK ? "returned 200 (dev identity)" : "returned 200",
    );
  } else if (res) {
    pass(`GET ${path} unauthenticated`, describe(res));
  } else {
    fail(`GET ${path} unauthenticated`, "unreachable");
  }
}

// L1+L2 — MCP surface: connect, exact tool set, one D1 read.
const client = new Client({ name: "cardex-smoke", version: "0.0.1" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: PROBE,
    }),
  );
  pass("MCP initialize");

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  if (JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS)) {
    pass("tools/list", names.join(", "));
  } else {
    fail("tools/list", `got ${names.join(", ")}`);
  }

  const tags = await client.callTool({ name: "list_tags", arguments: {} });
  const tagPayload = tags.structuredContent as
    | { ok?: boolean; records?: unknown[] }
    | undefined;
  if (tagPayload?.ok === true && (tagPayload.records?.length ?? 0) > 0) {
    pass("list_tags", `${tagPayload.records!.length} records`);
  } else {
    fail("list_tags", JSON.stringify(tagPayload));
  }

  // L4 — soft: index absent/empty degrades to search_unavailable, which is
  // legal; only an unexpected failure or a thrown call warns.
  try {
    const res = await client.callTool({
      name: "search_terms",
      arguments: { query: "年費", detail: "candidates" },
    });
    const body = res.structuredContent as
      | { ok?: boolean; error?: string }
      | undefined;
    if (body?.ok === true) {
      pass("search_terms", "index answering");
    } else if (body?.error === "search_unavailable") {
      warn("search_terms", "degraded: search_unavailable");
    } else {
      warn("search_terms", `unexpected payload ${JSON.stringify(body)}`);
    }
  } catch (e) {
    warn("search_terms", `call threw: ${e}`);
  }
} catch (e) {
  fail("MCP connect", `${e}`);
} finally {
  await client.close().catch(() => {});
}

console.log(failures === 0 ? "\nsmoke: all hard checks passed" : `\nsmoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
