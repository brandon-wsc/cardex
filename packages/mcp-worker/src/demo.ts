import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = 8787;
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const calls: { title: string; tool: string; args: Record<string, unknown> }[] = [
  { title: "resolve_alias 茶餐廳", tool: "resolve_alias", args: { query: "茶餐廳" } },
  {
    title: "lookup_rates dining, default limit",
    tool: "lookup_rates",
    args: { tag_id: "dining" },
  },
  { title: "get_card card_hsbc_red", tool: "get_card", args: { id: "card_hsbc_red" } },
  {
    title: "get_term term_hsbc_dining_cap",
    tool: "get_term",
    args: { id: "term_hsbc_dining_cap" },
  },
  {
    title: "score HK$800 dining, no assumptions",
    tool: "score_candidates",
    args: { amount_hkd: 800, alias: "茶餐廳" },
  },
  {
    title: "score HK$800 dining, cap known, Octopus cleared",
    tool: "score_candidates",
    args: {
      amount_hkd: 800,
      alias: "茶餐廳",
      assumptions: {
        month_to_date_rebate_hkd: 250,
        checked_exclusions: ["octopus_topup"],
      },
    },
  },
  {
    title: "resolve_alias 八達通 (unmapped)",
    tool: "resolve_alias",
    args: { query: "八達通" },
  },
  {
    title: "score HK$1000 overseas, points value unknown",
    tool: "score_candidates",
    args: { amount_hkd: 1000, tag_ids: ["overseas"] },
  },
];

const wrangler = spawn(
  "pnpm",
  ["exec", "wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"],
  { cwd: PACKAGE_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);

let stderr = "";
wrangler.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
  if (stderr.length > 4000) stderr = stderr.slice(-4000);
});

function stopWrangler() {
  if (wrangler.pid) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      try {
        wrangler.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}
process.on("SIGINT", () => {
  stopWrangler();
  process.exit(130);
});

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(MCP_URL, { method: "GET" });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`wrangler dev did not come up on ${MCP_URL}\n${stderr}`);
}

try {
  await waitForServer();
  const client = new Client({ name: "cardex-demo", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

  for (const call of calls) {
    const result = await client.callTool({ name: call.tool, arguments: call.args });
    console.log(`\n## ${call.title}\n`);
    const text = result.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    console.log(
      JSON.stringify(result.structuredContent ?? (text ? JSON.parse(text) : result), null, 2),
    );
  }
  await client.close();
} finally {
  stopWrangler();
}
