import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { proposeChange } from "./maintain.js";
import { payload, registerReadTools, strictInput } from "./server.js";

const patch = strictInput({
  op: z.enum(["insert", "update", "delete"]),
  table: z.string(),
  id: z.string(),
  key: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional(),
  set: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional(),
});

// /maintainer's MCP surface: fact reads plus proposals. Public reports are
// reviewed through /admin, never exposed to the maintenance agent.
export function buildMaintainerServer(db: D1Database): McpServer {
  const server = new McpServer({
    name: "cardex-maintainer",
    version: "0.0.1",
  });
  registerReadTools(server, db);

  server.registerTool(
    "propose_change",
    {
      description:
        "Propose a fact change for owner review. Patches are structured ops — {op: insert|update|delete, table, id, key?, set?} — whitelisted to facts tables and named columns; raw SQL is rejected simultaneously with everything else. Evidence URL is required. The owner approves or rejects in the portal; nothing here writes facts directly.",
      inputSchema: strictInput({
        proposed_by: z.string().optional(),
        summary: z.string(),
        evidence_url: z.string(),
        excerpt: z.string().optional(),
        patches: z.array(patch),
      }),
    },
    async (args) => payload(await proposeChange(db, args)),
  );

  return server;
}
