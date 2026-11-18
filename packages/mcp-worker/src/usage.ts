// ADR 0016: coarse server-side usage counters into Workers Analytics
// Engine. Columns are positional (AE has no named columns) — the legend
// lives in docs/adr/0016-usage-counters.md.
//
// Everything written here is a whitelisted bucket: arg key NAMES but never
// values, bucketed User-Agent/clientInfo strings, and coarse geo mapped from
// request.cf.country. Never IPs, raw UA, session ids, or free text — the
// search_terms / resolve_alias / report_issue strings stay out by construction.
import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  readRequestBody,
} from "@modelcontextprotocol/server";

export interface DataPoint {
  blobs: string[];
  doubles: number[];
  indexes?: string[];
}

export type UsageSink = Pick<AnalyticsEngineDataset, "writeDataPoint">;

export type Surface = "mcp" | "maintainer" | "admin" | "asset_miss";

export interface ToolUsage {
  sink: UsageSink | undefined;
  surface: Surface;
  reqId: string;
  ua: string;
  country: string;
  traffic: string;
  protocol: string;
  client: string;
}

export interface RequestUsage {
  tool: ToolUsage;
  observe(body: unknown): void;
  finish(response: Response, latencyMs: number, body: unknown): Promise<void>;
}

export interface McpBody {
  parsed: boolean;
  value: unknown;
}

const NONE = "-";

const UA_MATCHES: [string, string][] = [
  ["claude", "claude"],
  ["cursor", "cursor"],
  ["chatgpt", "chatgpt"],
  ["openai", "chatgpt"],
  ["grok", "grok"],
  ["inspector", "inspector"],
  ["censys", "scanner"],
  ["masscan", "scanner"],
  ["zmap", "scanner"],
  ["python", "python"],
  ["httpx", "python"],
  ["aiohttp", "python"],
  ["node", "node"],
  ["undici", "node"],
  ["axios", "node"],
  ["mozilla", "browser"],
  ["safari", "browser"],
];

const CLIENT_BUCKETS: Record<string, string> = {
  claude: "claude",
  "claude-ai": "claude",
  "claude-desktop": "claude",
  "claude-code": "claude",
  "anthropic/claudeai": "claude",
  "anthropic/api": "anthropic_api",
  cursor: "cursor",
  "cursor-vscode": "cursor",
  chatgpt: "chatgpt",
  openai: "chatgpt",
  "openai-mcp": "chatgpt",
  codex: "codex",
  "codex-cli": "codex",
  "codex-mcp-client": "codex",
  inspector: "inspector",
  "mcp-inspector": "inspector",
  "inspector-client": "inspector",
  vscode: "vscode",
  "visual studio code": "vscode",
  "visual studio code - insiders": "vscode",
  grok: "grok",
  "gemini-cli": "gemini",
  "gemini-cli-mcp-client": "gemini",
  cline: "cline",
  "continue-client": "continue",
  "continue-cli-client": "continue",
  goose: "goose",
};

const bucketed = (value: string, matches: [string, string][]) => {
  for (const [needle, bucket] of matches) {
    if (value.includes(needle)) return bucket;
  }
  return "other";
};

// UA describes the transport; x-cardex-probe is a separate traffic dimension.
export function uaBucket(request: Request): string {
  const ua = (request.headers.get("user-agent") ?? "").toLowerCase();
  if (!ua) return NONE;
  return bucketed(ua, UA_MATCHES);
}

// MCP clientInfo.name is caller-controlled free text — exact known names map
// to buckets; everything else becomes "other" and is never recorded raw.
export function clientBucket(name: unknown): string {
  if (typeof name !== "string" || !name) return NONE;
  return CLIENT_BUCKETS[name.toLowerCase()] ?? "other";
}

const methodOf = (m: unknown): string | null =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as { method?: unknown }).method === "string"
    ? (m as { method: string }).method
    : null;

export function rpcMethod(body: unknown): string {
  if (Array.isArray(body)) return "batch";
  const method = methodOf(body);
  if (method === null) return "none";
  switch (method) {
    case "server/discover":
    case "initialize":
    case "tools/list":
    case "tools/call":
    case "ping":
      return method;
    default:
      return method.startsWith("notifications/") ? "notification" : "other";
  }
}

const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

const protocolBucket = (value: unknown): string => {
  if (typeof value !== "string" || !value) return NONE;
  return PROTOCOLS.has(value) ? value : "other";
};

function requestClient(body: unknown): string {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (typeof m !== "object" || m === null) continue;
    const params = (m as {
      params?: {
        clientInfo?: { name?: unknown };
        _meta?: Record<string, { name?: unknown } | undefined>;
      };
    }).params;
    if (methodOf(m) === "initialize")
      return clientBucket(params?.clientInfo?.name);
    const modern = params?._meta?.[CLIENT_INFO_META];
    if (modern) return clientBucket(modern.name);
  }
  return NONE;
}

function requestProtocol(request: Request, body: unknown): string {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (typeof m !== "object" || m === null) continue;
    const params = (m as {
      params?: {
        protocolVersion?: unknown;
        _meta?: Record<string, unknown>;
      };
    }).params;
    const modern = params?._meta?.[PROTOCOL_VERSION_META];
    if (modern !== undefined) return protocolBucket(modern);
    if (methodOf(m) === "initialize")
      return protocolBucket(params?.protocolVersion);
  }
  return protocolBucket(request.headers.get("mcp-protocol-version"));
}

const trafficBucket = (request: Request): string =>
  request.headers.has("x-cardex-probe") ? "self" : "external";

export async function parseMcpBody(request: Request): Promise<McpBody> {
  try {
    // The SDK and generated Worker types use different workers-types Cf
    // generics; the runtime value is the same standard Request.
    const clone = request.clone() as unknown as Parameters<
      typeof readRequestBody
    >[0];
    const body = await readRequestBody(clone, DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (body.tooLarge) return { parsed: false, value: undefined };
    return { parsed: true, value: JSON.parse(body.text) };
  } catch {
    return { parsed: false, value: undefined };
  }
}

const ARG_KEYS = new Set([
  "alias",
  "amount",
  "amount_hkd",
  "as_of",
  "assumptions",
  "card_id",
  "card_ids",
  "claimed_value",
  "currency",
  "detail",
  "evidence_url",
  "excerpt",
  "field",
  "id",
  "issuer",
  "limit",
  "merchant",
  "min_similarity",
  "note",
  "patches",
  "proposed_by",
  "query",
  "rate_id",
  "summary",
  "tag_id",
  "tag_ids",
  "term_id",
]);

export function argKeys(args: unknown): string {
  if (typeof args !== "object" || args === null) return NONE;
  const keys = Object.keys(args)
    .filter(
      (k) =>
        ARG_KEYS.has(k) &&
        (args as Record<string, unknown>)[k] !== undefined,
    )
    .sort();
  return keys.length ? keys.join("+") : NONE;
}

const RESULT_LISTS: Record<string, string> = {
  lookup_rates: "records",
  list_tags: "records",
  resolve_alias: "matches",
  score_candidates: "candidates",
};
const SINGLETON_RESULTS = new Set([
  "get_card",
  "get_term",
  "report_issue",
  "propose_change",
]);
const DOMAIN_ERRORS = new Set([
  "not_found",
  "invalid_limit",
  "invalid_amount",
  "invalid_currency",
  "invalid_date",
  "invalid_report",
  "missing_filter",
  "missing_spend",
  "unmapped_merchant",
  "missing_fx_rate",
  "invalid_query",
  "search_unavailable",
]);

function structuredContent(result: unknown): Record<string, unknown> | null {
  const content =
    typeof result === "object" && result !== null
      ? (result as { structuredContent?: unknown }).structuredContent
      : undefined;
  return typeof content === "object" && content !== null
    ? (content as Record<string, unknown>)
    : null;
}

function resultCount(name: string, result: unknown): number {
  const content = structuredContent(result);
  if (content?.ok !== true) return 0;
  const key =
    name === "search_terms"
      ? content.detail === "candidates"
        ? "candidates"
        : "records"
      : RESULT_LISTS[name];
  if (key) {
    const records = content[key];
    return Array.isArray(records) ? records.length : 0;
  }
  return SINGLETON_RESULTS.has(name) ? 1 : 0;
}

function toolError(result: unknown, outcome: string): string {
  if (outcome === "thrown") return "thrown";
  if (outcome === "ok") return NONE;
  const error = structuredContent(result)?.error;
  return typeof error === "string" && DOMAIN_ERRORS.has(error)
    ? error
    : "tool_error";
}

function outcomeFromStatus(status: number): string {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status >= 400) return "error";
  return "ok";
}

const JSON_RPC_ERRORS: Record<number, string> = {
  [-32700]: "parse_error",
  [-32600]: "invalid_request",
  [-32601]: "method_not_found",
  [-32602]: "invalid_params",
  [-32603]: "internal",
  [-32002]: "not_found",
  [-32020]: "header_mismatch",
  [-32021]: "missing_capability",
  [-32022]: "unsupported_protocol",
};

function jsonRpcErrorCode(body: unknown): number | null {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (typeof m !== "object" || m === null) continue;
    const error = (m as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) continue;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

function statusError(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 406) return "not_acceptable";
  if (status === 413) return "payload_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal";
  return NONE;
}

function validationError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const result = (body as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  const view = result as {
    isError?: unknown;
    structuredContent?: unknown;
    content?: unknown;
  };
  if (view.isError !== true || view.structuredContent !== undefined)
    return null;
  const first = Array.isArray(view.content) ? view.content[0] : undefined;
  const text =
    typeof first === "object" && first !== null
      ? (first as { text?: unknown }).text
      : undefined;
  return typeof text === "string" &&
    text.startsWith("Input validation error:")
    ? "invalid_params"
    : null;
}

function classifyRpcBody(body: unknown, status: number): string {
  const code = jsonRpcErrorCode(body);
  if (code !== null) {
    const mapped = JSON_RPC_ERRORS[code];
    if (mapped) return mapped;
    const fromStatus = statusError(status);
    return fromStatus === NONE ? "rpc_error" : fromStatus;
  }
  return validationError(body) ?? statusError(status);
}

async function firstSseMessage(response: Response): Promise<unknown> {
  const body = response.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (buffer.length <= 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      // eslint-disable-next-line cardex/money-math -- SSE byte chunk, not money
      buffer += decoder.decode(value, { stream: true });
      const end = buffer.search(/\r?\n\r?\n/);
      if (end >= 0 && end <= 64 * 1024) {
        buffer = buffer.slice(0, end);
        break;
      }
      if (buffer.length > 64 * 1024) {
        buffer = buffer.slice(0, 64 * 1024);
        break;
      }
    }
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

async function rpcError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream"))
    return classifyRpcBody(await firstSseMessage(response), response.status);
  if (contentType.includes("application/json")) {
    const body = await response.clone().json().catch(() => undefined);
    return classifyRpcBody(body, response.status);
  }
  return statusError(response.status);
}

// One "request" row per public MCP request plus the shared context the
// "tool_call" rows need. req_id is a per-request sampling key and cannot
// link two requests by one caller; privileged surfaces stay unrecorded.
export function beginUsage(
  request: Request,
  sink: UsageSink | undefined,
  surface: Surface,
): RequestUsage {
  const reqId = crypto.randomUUID();
  const ua = uaBucket(request);
  const country =
    request.cf && typeof request.cf.country === "string"
      ? request.cf.country === "HK"
        ? "hk"
        : "other"
      : NONE;
  const activeSink = surface === "mcp" ? sink : undefined;
  const tool: ToolUsage = {
    sink: activeSink,
    surface,
    reqId,
    ua,
    country,
    traffic: trafficBucket(request),
    protocol: requestProtocol(request, undefined),
    client: NONE,
  };
  return {
    tool,
    observe(body) {
      tool.protocol = requestProtocol(request, body);
      tool.client = requestClient(body);
    },
    async finish(response, latencyMs, body) {
      if (!activeSink) return;
      const error = await rpcError(response);
      activeSink.writeDataPoint({
        blobs: [
          "request",
          surface,
          rpcMethod(body),
          outcomeFromStatus(response.status),
          ua,
          country,
          tool.client,
          tool.traffic,
          tool.protocol,
          error,
        ],
        doubles: [latencyMs],
        indexes: [reqId],
      });
    },
  };
}

// Wraps one tool handler: writes a "tool_call" row with the outcome, arg
// key names, latency, and result size. Errors still propagate — the row is
// written first so a thrown handler still counts.
export async function trackTool<T>(
  usage: ToolUsage | undefined,
  name: string,
  args: unknown,
  run: () => T | Promise<T>,
): Promise<T> {
  if (!usage?.sink) return run();
  const t0 = Date.now();
  let outcome = "ok";
  try {
    const res = await run();
    if (
      typeof res === "object" &&
      res !== null &&
      (res as { isError?: unknown }).isError === true
    ) {
      outcome = "error";
    }
    usage.sink.writeDataPoint({
      blobs: [
        "tool_call",
        usage.surface,
        name,
        outcome,
        usage.ua,
        usage.country,
        argKeys(args),
        usage.traffic,
        usage.protocol,
        toolError(res, outcome),
        usage.client,
      ],
      doubles: [Date.now() - t0, resultCount(name, res)],
      indexes: [usage.reqId],
    });
    return res;
  } catch (err) {
    usage.sink.writeDataPoint({
      blobs: [
        "tool_call",
        usage.surface,
        name,
        "thrown",
        usage.ua,
        usage.country,
        argKeys(args),
        usage.traffic,
        usage.protocol,
        "thrown",
        usage.client,
      ],
      doubles: [Date.now() - t0, 0],
      indexes: [usage.reqId],
    });
    throw err;
  }
}
