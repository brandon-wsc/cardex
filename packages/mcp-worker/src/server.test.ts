import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "./server";

// Wire-level contract specs for PRD v0.4: every tool input schema is strict.
// A mistyped key (tag instead of tag_id, cards instead of card_ids) must
// surface as an InvalidParams error — never silently strip to a filter-less
// call, which used to dump the whole catalog.
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

async function connect() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = buildServer(tenv.DB);
  await server.connect(serverTransport);
  const client = new Client({ name: "cardex-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function errorText(res: unknown): string {
  const content = (res as { content?: { type: string; text?: string }[] })
    .content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

describe("public tool surface", () => {
  it("exposes only the seven PRD tools — no report reads or proposals", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "get_card",
          "get_term",
          "list_tags",
          "lookup_rates",
          "report_issue",
          "resolve_alias",
          "score_candidates",
        ].sort(),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("strict tool input", () => {
  it("errors on a mistyped lookup_rates key instead of dumping the catalog", async () => {
    const { client, server } = await connect();
    try {
      // The footgun from the raw POST /mcp evidence: {"tag": "online"} used
      // to strip to {} and return every rate in the catalog.
      for (const args of [
        { tag: "online" },
        { cards: ["card_hsbc_red"] },
      ]) {
        const res = await client.callTool({
          name: "lookup_rates",
          arguments: args,
        });
        expect(res.isError).toBe(true);
        expect(res.structuredContent).toBeUndefined();
        expect(errorText(res)).toMatch(/invalid|unrecognized/i);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("flags a missing_filter failure with isError while keeping the structured payload", async () => {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({
        name: "lookup_rates",
        arguments: {},
      });
      // Domain failure, not a protocol error: the structured ok:false
      // payload survives, but isError still tells the caller it failed.
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({
        ok: false,
        error: "missing_filter",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not flag a partial success — an unknown tag still answers ok", async () => {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({
        name: "lookup_rates",
        arguments: { tag_id: "tag_that_does_not_exist" },
      });
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).toMatchObject({
        ok: true,
        unknown_tag_id: "tag_that_does_not_exist",
        records: [],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("flags a score_candidates failure with isError", async () => {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({
        name: "score_candidates",
        arguments: { amount_hkd: 800 },
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({
        ok: false,
        error: "missing_spend",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("still answers a well-formed lookup_rates call", async () => {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({
        name: "lookup_rates",
        arguments: { tag_id: "online" },
      });
      expect(res.structuredContent).toMatchObject({ ok: true, total: 2 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("errors on unknown keys in the other tools' input", async () => {
    const { client, server } = await connect();
    try {
      for (const [name, args] of [
        ["get_card", { card: "card_hsbc_red" }],
        ["score_candidates", { amount_hkd: 800, tag: "dining" }],
      ] as const) {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError).toBe(true);
        expect(errorText(res)).toMatch(/invalid|unrecognized/i);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists the valid keys on an unrecognized-key error", async () => {
    const { client, server } = await connect();
    try {
      // "tag" for tag_id is the documented footgun — the error should say
      // what was rejected and what the tool actually takes.
      const res = await client.callTool({
        name: "lookup_rates",
        arguments: { tag: "online" },
      });
      expect(res.isError).toBe(true);
      const text = errorText(res);
      expect(text).toContain('"tag"');
      expect(text).toContain("tag_id");
      expect(text).toContain("card_ids");

      const scored = await client.callTool({
        name: "score_candidates",
        arguments: { amount_hkd: 800, cards: ["card_hsbc_red"] },
      });
      expect(scored.isError).toBe(true);
      expect(errorText(scored)).toContain("card_ids");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
