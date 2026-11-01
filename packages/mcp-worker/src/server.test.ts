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

  it("returns a missing_filter payload for a valid but filter-less call", async () => {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({
        name: "lookup_rates",
        arguments: {},
      });
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).toMatchObject({
        ok: false,
        error: "missing_filter",
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
});
