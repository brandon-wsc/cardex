import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { listReports, proposeChange } from "./maintain.js";
import { registerReadTools, strictInput } from "./server.js";

function payload(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

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

// /maintainer's MCP surface (ADR 0002): fact reads plus the two maintenance
// tools. The only write capability is inserting rows into proposals — the
// token holder can never touch facts, reports, or proposal status.
export function buildMaintainerServer(db: D1Database): McpServer {
  const server = new McpServer({
    name: "cardex-maintainer",
    version: "0.0.1",
  });
  registerReadTools(server, db);

  server.registerTool(
    "list_reports",
    {
      description:
        "Quarantined issue reports submitted by public callers, newest first. Use them as leads: verify against the issuer page before proposing a change.",
      inputSchema: strictInput({ limit: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await listReports(db, args)),
  );

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
