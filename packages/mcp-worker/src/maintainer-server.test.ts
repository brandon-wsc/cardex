import { applyD1Migrations, env } from "cloudflare:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMaintainerServer } from "./maintainer-server";

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

describe("maintainer MCP capabilities", () => {
  it("does not expose public reports to the maintainer agent", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildMaintainerServer(tenv.DB);
    await server.connect(serverTransport);
    const client = new Client({ name: "cardex-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain("list_reports");
      expect(tools.tools.map((tool) => tool.name)).toContain("propose_change");
      await expect(
        client.callTool({ name: "list_reports", arguments: {} }),
      ).rejects.toThrow("Tool list_reports not found");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
