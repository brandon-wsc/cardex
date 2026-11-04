import { applyD1Migrations, env } from "cloudflare:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMaintainerServer } from "./maintainer-server";
import { buildServer } from "./server";

// Drift guard for the consumer skills in skills/: each SKILL.md must name
// every tool its server registers, and its ## Tools table may not claim a
// tool the server does not have. Rename or add a tool and this goes red
// until the doc catches up.
const tenv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  SEED_SQL: string;
  CARDEX_SKILL: string;
  MAINTAINER_SKILL: string;
};

beforeEach(async () => {
  await applyD1Migrations(tenv.DB, tenv.TEST_MIGRATIONS);
  const statements = tenv.SEED_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await tenv.DB.batch(statements.map((sql) => tenv.DB.prepare(sql)));
});

async function registeredTools(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "cardex-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

// Tool names claimed by the doc's own ## Tools table — first-column
// backticked identifiers only, so prose mentions elsewhere don't count.
function claimedTools(skillMd: string): string[] {
  const section = skillMd
    .split(/^## /m)
    .find((s) => s.startsWith("Tools"));
  if (!section) return [];
  return [...section.matchAll(/^\| `([a-z][a-z0-9_]*)`/gm)].map((m) => m[1]);
}

describe.each([
  ["cardex", () => buildServer(tenv.DB), () => tenv.CARDEX_SKILL],
  [
    "cardex-maintainer",
    () => buildMaintainerServer(tenv.DB),
    () => tenv.MAINTAINER_SKILL,
  ],
])("%s consumer skill stays in sync with its server", (_, build, skillMd) => {
  it("names every registered tool somewhere in the doc", async () => {
    for (const name of await registeredTools(build())) {
      expect(skillMd(), `missing \`${name}\``).toContain(`\`${name}\``);
    }
  });

  it("claims no tool in its ## Tools table that the server lacks", async () => {
    const registered = await registeredTools(build());
    for (const name of claimedTools(skillMd())) {
      expect(registered, `doc claims \`${name}\``).toContain(name);
    }
  });
});
