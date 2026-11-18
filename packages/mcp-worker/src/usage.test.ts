import {
  applyD1Migrations,
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import worker from "./index";
import { buildServer } from "./server.js";
import type { TermSearchDeps } from "./query.js";
import {
  argKeys,
  clientBucket,
  rpcMethod,
  uaBucket,
  type DataPoint,
  type ToolUsage,
} from "./usage.js";

// ADR 0016: usage counters are the only telemetry — whitelisted buckets,
// arg key names but never values, and no direct person identifiers. The
// canary spec is the privacy gate: free-text input must never reach a
// data point.
const tenv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  SEED_SQL: string;
};

beforeEach(async () => {
  await applyD1Migrations(tenv.DB, tenv.TEST_MIGRATIONS);
  const statements = tenv.SEED_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await tenv.DB.batch(statements.map((sql) => tenv.DB.prepare(sql)));
});

function fakeSink() {
  const points: DataPoint[] = [];
  return {
    points,
    sink: { writeDataPoint: (p: DataPoint) => void points.push(p) },
  };
}

const baseEnv = {
  DB: tenv.DB,
  MAINTAINER_TOKEN: "test-token",
  ADMIN_EMAIL: "owner@example.com",
  DEV_ADMIN_EMAIL: "owner@example.com",
  ASSETS: { fetch: () => Promise.resolve(new Response("asset")) },
};

const contexts = new WeakMap<Response, ExecutionContext>();

async function call(
  path: string,
  init: RequestInit | undefined,
  over: object = {},
  host = "cardex.test",
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://${host}${path}`, init),
    { ...baseEnv, ...over } as unknown as Env,
    ctx,
  );
  contexts.set(response, ctx);
  return response;
}

async function drain(response: Response): Promise<void> {
  await response.text();
  const ctx = contexts.get(response);
  if (ctx) await waitOnExecutionContext(ctx);
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const rpc = (method: string, params?: unknown) => ({
  method: "POST",
  headers: { ...MCP_HEADERS, "CF-Connecting-IP": "10.9.9.9" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

const modernRpc = (
  method: string,
  params: Record<string, unknown> = {},
) => ({
  ...rpc(method, {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        name: "cursor-vscode",
        version: "1.0",
      },
    },
  }),
  headers: {
    ...MCP_HEADERS,
    "CF-Connecting-IP": "10.9.9.9",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
  },
});

const req = (ua?: string, headers?: Record<string, string>) =>
  new Request("https://cardex.test/mcp", {
    method: "POST",
    headers: { ...(ua ? { "user-agent": ua } : {}), ...headers },
  });

describe("ua_bucket", () => {
  it("buckets known agents, browsers, and probes", () => {
    expect(uaBucket(req("Cursor/1.0.0"))).toBe("cursor");
    expect(uaBucket(req("python-httpx2/2.15.1"))).toBe("python");
    expect(uaBucket(req("claude-cli/1.2.3"))).toBe("claude");
    expect(uaBucket(req("Mozilla/5.0 (iPhone)"))).toBe("browser");
    expect(uaBucket(req("WeirdThing/9.9"))).toBe("other");
    expect(uaBucket(req())).toBe("-");
    expect(uaBucket(req("Mozilla/5.0", { "x-cardex-probe": "1" }))).toBe(
      "browser",
    );
  });
});

describe("client bucket", () => {
  it("buckets clientInfo.name and tolerates junk", () => {
    expect(clientBucket("claude-code")).toBe("claude");
    expect(clientBucket("cursor-vscode")).toBe("cursor");
    expect(clientBucket("mcp-inspector")).toBe("inspector");
    expect(clientBucket("Anthropic/API")).toBe("anthropic_api");
    expect(clientBucket("Cline")).toBe("cline");
    expect(clientBucket("continue-client")).toBe("continue");
    expect(clientBucket("not-claude-at-all")).toBe("other");
    expect(clientBucket("totally-new-client")).toBe("other");
    expect(clientBucket(undefined)).toBe("-");
    expect(clientBucket(42)).toBe("-");
  });
});

describe("rpc method bucket", () => {
  it("names single requests, batches, notifications, and junk", () => {
    expect(rpcMethod({ method: "tools/call" })).toBe("tools/call");
    expect(rpcMethod({ method: "initialize" })).toBe("initialize");
    expect(rpcMethod([{ method: "tools/call" }, { method: "ping" }])).toBe(
      "batch",
    );
    expect(
      rpcMethod([{ method: "tools/call" }, { method: "tools/call" }]),
    ).toBe("batch");
    expect(rpcMethod({ method: "notifications/initialized" })).toBe(
      "notification",
    );
    expect(rpcMethod("garbage")).toBe("none");
  });
});

describe("arg_keys", () => {
  it("records sorted key names only — never values", () => {
    expect(argKeys({ issuer: "hsbc-secret", tag_id: "dining" })).toBe(
      "issuer+tag_id",
    );
    expect(argKeys({})).toBe("-");
    expect(argKeys(undefined)).toBe("-");
    expect(argKeys({ a: undefined, limit: 1 })).toBe("limit");
    expect(
      argKeys({ query: "ok", "canary-personal-data-xyz": "secret" }),
    ).toBe("query");
    expect(argKeys({ "canary-personal-data-xyz": "secret" })).toBe("-");
  });
});

describe("usage data points", () => {
  it("writes a request row and a tool_call row for a tools/call", async () => {
    const { points, sink } = fakeSink();
    const res = await call(
      "/mcp",
      rpc("tools/call", { name: "list_tags", arguments: { limit: 5 } }),
      { USAGE: sink },
    );
    expect(res.status).toBe(200);
    await drain(res);

    const request = points.find((p) => p.blobs[0] === "request");
    const tool = points.find((p) => p.blobs[0] === "tool_call");
    expect(request?.blobs.slice(1)).toEqual([
      "mcp",
      "tools/call",
      "ok",
      "-",
      "-",
      "-",
      "external",
      "-",
      "-",
    ]);
    expect(tool?.blobs.slice(1)).toEqual([
      "mcp",
      "list_tags",
      "ok",
      "-",
      "-",
      "limit",
      "external",
      "-",
      "-",
      "-",
    ]);
    expect(tool?.indexes).toEqual(request?.indexes);
    expect(tool?.doubles[1]).toBeGreaterThan(0);
  });

  it("captures the initialize method and the clientInfo bucket", async () => {
    const { points, sink } = fakeSink();
    const res = await call(
      "/mcp",
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor-vscode", version: "1.0" },
      }),
      { USAGE: sink },
    );
    await drain(res);
    const request = points.find((p) => p.blobs[0] === "request");
    expect(request?.blobs[2]).toBe("initialize");
    expect(request?.blobs[6]).toBe("cursor");
  });

  it("captures modern discovery, client, protocol, and external traffic", async () => {
    const { points, sink } = fakeSink();
    const res = await call("/mcp", modernRpc("server/discover"), {
      USAGE: sink,
    });
    expect(res.status).toBe(200);
    await drain(res);

    const request = points.find((p) => p.blobs[0] === "request");
    expect(request?.blobs[2]).toBe("server/discover");
    expect(request?.blobs[6]).toBe("cursor");
    expect(request?.blobs[7]).toBe("external");
    expect(request?.blobs[8]).toBe("2026-07-28");
  });

  it("carries modern client and protocol into the tool_call row", async () => {
    const { points, sink } = fakeSink();
    const res = await call(
      "/mcp",
      modernRpc("tools/call", {
        name: "list_tags",
        arguments: { limit: 1 },
      }),
      { USAGE: sink },
    );
    expect(res.status).toBe(200);
    await drain(res);

    const tool = points.find((p) => p.blobs[0] === "tool_call");
    expect(tool?.blobs[7]).toBe("external");
    expect(tool?.blobs[8]).toBe("2026-07-28");
    expect(tool?.blobs[9]).toBe("-");
    expect(tool?.blobs[10]).toBe("cursor");
  });

  it("keeps self-traffic separate from UA and coarsens HK geo", async () => {
    const { points, sink } = fakeSink();
    const request = rpc("tools/list");
    const res = await call(
      "/mcp",
      {
        ...request,
        headers: {
          ...request.headers,
          "user-agent": "Mozilla/5.0",
          "x-cardex-probe": "1",
        },
        cf: { country: "HK" },
      },
      { USAGE: sink },
    );
    expect(res.status).toBe(200);
    await drain(res);

    const row = points.find((p) => p.blobs[0] === "request");
    expect(row?.blobs[4]).toBe("browser");
    expect(row?.blobs[5]).toBe("hk");
    expect(row?.blobs[7]).toBe("self");
  });

  it("does not record privileged-surface activity", async () => {
    const { points, sink } = fakeSink();
    const maintainer = await call(
      "/maintainer",
      {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          "CF-Connecting-IP": "10.9.9.8",
          Authorization: "Bearer wrong",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      { USAGE: sink },
    );
    expect(maintainer.status).toBe(401);
    const admin = await call(
      "/admin/api/me",
      { method: "GET" },
      { USAGE: sink },
    );
    expect(admin.status).toBe(401);
    expect(points).toEqual([]);
  });

  it("classifies malformed JSON as an HTTP and JSON-RPC parse error", async () => {
    const { points, sink } = fakeSink();
    const request = rpc("tools/list");
    const res = await call(
      "/mcp",
      { ...request, body: "{" },
      { USAGE: sink },
    );
    expect(res.status).toBe(400);
    await drain(res);

    const row = points.find((p) => p.blobs[0] === "request");
    expect(row?.blobs[3]).toBe("error");
    expect(row?.blobs[9]).toBe("parse_error");
  });

  it("records rejected tool params without a tool_call row", async () => {
    const { points, sink } = fakeSink();
    const res = await call(
      "/mcp",
      rpc("tools/call", {
        name: "list_tags",
        arguments: { "canary-personal-data-xyz": "secret" },
      }),
      { USAGE: sink },
    );
    await drain(res);

    const row = points.find((p) => p.blobs[0] === "request");
    expect(row?.blobs[9]).toBe("invalid_params");
    expect(points.find((p) => p.blobs[0] === "tool_call")).toBeUndefined();
    for (const p of points) {
      for (const b of p.blobs) {
        expect(b).not.toContain("canary-personal-data-xyz");
      }
    }
  });

  it("classifies an over-limit declared body without reading it", async () => {
    const { points, sink } = fakeSink();
    const request = rpc("tools/list");
    const res = await call(
      "/mcp",
      {
        ...request,
        headers: {
          ...request.headers,
          "content-length": String(4 * 1024 * 1024 + 1),
        },
      },
      { USAGE: sink },
    );
    expect(res.status).toBe(413);
    await drain(res);

    const row = points.find((p) => p.blobs[0] === "request");
    expect(row?.blobs[3]).toBe("error");
    expect(row?.blobs[9]).toBe("payload_too_large");
  });

  it("never writes free-text args — the search_terms canary", async () => {
    const { points, sink } = fakeSink();
    const canary = "canary-personal-data-xyz";
    const res = await call(
      "/mcp",
      rpc("tools/call", {
        name: "search_terms",
        arguments: { query: canary },
      }),
      { USAGE: sink },
    );
    // The tool handler runs while the SSE body streams — drain it.
    await drain(res);
    const tool = points.find((p) => p.blobs[0] === "tool_call");
    expect(tool?.blobs[2]).toBe("search_terms");
    expect(tool?.blobs[6]).toBe("query");
    for (const p of points) {
      for (const b of p.blobs) {
        expect(b).not.toContain(canary);
      }
    }
  });

  it("serves the surface untouched when the binding is absent", async () => {
    const res = await call(
      "/mcp",
      rpc("tools/call", { name: "list_tags", arguments: {} }),
    );
    expect(res.status).toBe(200);
  });
});

describe("tool-level tracking", () => {
  const usageFor = (sink: ToolUsage["sink"]): ToolUsage => ({
    sink,
    surface: "mcp",
    reqId: "req-test",
    ua: "other",
    country: "-",
    traffic: "external",
    protocol: "-",
    client: "-",
  });

  async function invokeTool(
    usage: ToolUsage,
    name: string,
    args: Record<string, unknown>,
    searchDeps: TermSearchDeps | null = null,
  ) {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildServer(tenv.DB, searchDeps, usage);
    await server.connect(serverTransport);
    const client = new Client({ name: "cardex-test", version: "0" });
    await client.connect(clientTransport);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("reports outcome=error when the tool payload is a domain failure", async () => {
    const { points, sink } = fakeSink();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildServer(tenv.DB, null, {
      sink,
      surface: "mcp",
      reqId: "req-test",
      ua: "other",
      country: "-",
      traffic: "self",
      protocol: "-",
      client: "-",
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "cardex-test", version: "0" });
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: "get_card",
        arguments: { id: "no_such_card" },
      });
    } finally {
      await client.close();
      await server.close();
    }
    const tool = points.find((p) => p.blobs[0] === "tool_call");
    expect(tool?.blobs[2]).toBe("get_card");
    expect(tool?.blobs[3]).toBe("error");
    expect(tool?.blobs[6]).toBe("id");
    expect(tool?.blobs[9]).toBe("not_found");
    expect(tool?.indexes).toEqual(["req-test"]);
  });

  it("counts score candidates rather than input tag ids", async () => {
    const { points, sink } = fakeSink();
    const result = await invokeTool(usageFor(sink), "score_candidates", {
      amount_hkd: 100,
      tag_ids: ["dining"],
    });
    const content = result.structuredContent as { candidates: unknown[] };
    const tool = points.find((p) => p.blobs[0] === "tool_call");
    expect(tool?.doubles[1]).toBe(content.candidates.length);
  });

  it("counts hydrated search records rather than dropped pointers", async () => {
    const { points, sink } = fakeSink();
    const result = await invokeTool(
      usageFor(sink),
      "search_terms",
      { query: "dining" },
      {
        embed: () => Promise.resolve([[0.5, 0.5]]),
        queryIndex: () =>
          Promise.resolve([
            { id: "term_hsbc_dining_cap", score: 0.9 },
            { id: "term_citi_super_cap", score: 0.8 },
            { id: "term_ghost", score: 0.7 },
          ]),
      },
    );
    const content = result.structuredContent as {
      records: unknown[];
      dropped_ids: unknown[];
    };
    expect(content.dropped_ids).toHaveLength(1);
    const tool = points.find((p) => p.blobs[0] === "tool_call");
    expect(tool?.doubles[1]).toBe(content.records.length);
  });

  it("counts a successful singleton read as one result", async () => {
    const { points, sink } = fakeSink();
    const result = await invokeTool(usageFor(sink), "get_term", {
      id: "term_hsbc_dining_cap",
    });
    expect(result.structuredContent).toMatchObject({ ok: true });
    const tool = points.find((p) => p.blobs[0] === "tool_call");
    expect(tool?.doubles[1]).toBe(1);
  });
});
