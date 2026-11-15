import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.CARDEX_VERIFY_URL;
const evidenceDir = process.env.CARDEX_VERIFY_EVIDENCE;
if (!url || !evidenceDir) {
  console.error("CARDEX_VERIFY_URL and CARDEX_VERIFY_EVIDENCE are required");
  process.exit(2);
}

const request = {
  name: "lookup_rates",
  arguments: { tag_id: "dining", limit: 2 },
};

async function main() {
const client = new Client({ name: "verify-cardex", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
try {
  const result = await client.callTool(request);
  const text = result.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const body = (result.structuredContent ??
    (text ? JSON.parse(text) : result)) as {
    ok?: boolean;
    error?: string;
    limit?: number;
    total?: number;
    filters?: { tag_id?: string | null };
    records?: unknown[];
    provenance?: unknown;
  };

  const records = Array.isArray(body.records) ? body.records : [];
  const problems: string[] = [];
  if (body.ok !== true) problems.push(`ok is ${String(body.ok)} (${body.error ?? "no error"})`);
  if (body.filters?.tag_id !== "dining") problems.push("filters.tag_id is not dining");
  if (body.limit !== 2) problems.push(`limit is ${String(body.limit)}`);
  if (records.length > 2) problems.push(`records.length ${records.length} exceeds limit 2`);
  if (typeof body.total === "number" && records.length !== Math.min(body.total, 2)) {
    problems.push(`records.length ${records.length} does not match min(total ${body.total}, 2)`);
  }
  if (body.provenance == null) problems.push("provenance is missing");

  const artifact = {
    feature: "lookup-rates",
    entry: "POST /mcp tool lookup_rates",
    request,
    response: body,
    observed: {
      ok: body.ok === true,
      tag_id: body.filters?.tag_id ?? null,
      limit: body.limit ?? null,
      total: body.total ?? null,
      recordCount: records.length,
    },
    problems,
  };

  mkdirSync(evidenceDir, { recursive: true });
  const path = `${evidenceDir}/lookup-rates.json`;
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(path);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
} finally {
  await client.close();
}
}

main();
