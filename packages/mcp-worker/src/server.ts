import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  getCard,
  getTerm,
  listTags,
  lookupRates,
  reportIssue,
  resolveAlias,
  scoreCandidates,
  searchTerms,
} from "./query.js";
import type { TermSearchDeps } from "./query.js";
import type { TermIndexDeps } from "./term-index-sync.js";
import { trackTool, type ToolUsage } from "./usage.js";

const SEED_NOTE =
  "Synthetic seed. Illustrative numbers, not issuer terms. Does not name a best card. Confirm with the issuer.";

// A strict object whose unrecognized-key error also lists the valid keys —
// zod's default names only the rejected key and leaves the caller guessing
// at the right spelling ("tag" for tag_id, "cards" for card_ids).
export function strictInput<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === "unrecognized_keys"
        ? `Unrecognized key${iss.keys.length === 1 ? "" : "s"}: ${iss.keys
            .map((k) => JSON.stringify(k))
            .join(", ")}. Valid keys: ${Object.keys(shape).sort().join(", ")}`
        : undefined,
  });
}

// A domain failure (ok:false) is an execution failure, so it also sets the
// MCP isError flag — the structured payload still carries the error detail.
// Partial successes (ok:true with unknown_tag_id(s) or unmatched keys) are
// not flagged: the tool answered, and the flags are part of the answer.
export function payload(value: object) {
  const failed = "ok" in value && value.ok === false;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    ...(failed ? { isError: true as const } : {}),
  };
}

const limit = z.number().int().optional();

export const TERM_SEARCH_MODEL = "@cf/baai/bge-m3";

// ADR 0014: wire the deployed bindings into the injected deps the query
// layer uses — a missing binding (or a test calling with no deps) makes the
// tool answer search_unavailable rather than guess at a fallback.
export function termSearchDeps(env: Env): TermSearchDeps | null {
  if (!env.AI || !env.TERMS_INDEX) return null;
  const ai = env.AI;
  const index = env.TERMS_INDEX;
  return {
    embed: async (texts) => {
      const out = await ai.run(TERM_SEARCH_MODEL, { text: texts });
      if (!("data" in out) || !out.data) {
        throw new Error("bge-m3 returned no embedding data");
      }
      return out.data;
    },
    queryIndex: async (vector, topK) => {
      const res = await index.query(vector, {
        topK,
        returnMetadata: "none",
      });
      return res.matches.map((match) => ({ id: match.id, score: match.score }));
    },
  };
}

// ADR 0015: the scheduled reconcile needs the same embed plus the index's
// mutation surface. Same fail-closed rule — absent bindings mean no run.
export function termIndexDeps(env: Env): TermIndexDeps | null {
  if (!env.AI || !env.TERMS_INDEX) return null;
  const ai = env.AI;
  const index = env.TERMS_INDEX;
  return {
    embed: async (texts) => {
      const out = await ai.run(TERM_SEARCH_MODEL, { text: texts });
      if (!("data" in out) || !out.data) {
        throw new Error("bge-m3 returned no embedding data");
      }
      return out.data;
    },
    getByIds: (ids) => index.getByIds(ids),
    upsert: (vectors) => index.upsert(vectors),
    deleteByIds: (ids) => index.deleteByIds(ids),
  };
}

// The public read tools, shared between /mcp and /maintainer (ADR 0002 —
// the maintainer surface exposes fact reads plus its own write-lite tools).
// Every input schema is strict: an unrecognized key is an InvalidParams
// error, never a silently stripped filter.
export function registerReadTools(
  server: McpServer,
  db: D1Database,
  searchDeps: TermSearchDeps | null = null,
): void {
  server.registerTool(
    "lookup_rates",
    {
      description: `Rates for a tag, card, or issuer. Requires at least one of tag_id, card_ids, issuer — a filter-less call returns missing_filter instead of the catalog. issuer takes the canonical issuer name or a known alias (never substring), and the response echoes the applied filters. Compact page. ${SEED_NOTE}`,
      inputSchema: strictInput({
        tag_id: z.string().optional(),
        card_ids: z.array(z.string()).optional(),
        issuer: z.string().optional(),
        as_of: z.string().optional(),
        limit,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await lookupRates(db, args)),
  );

  server.registerTool(
    "get_card",
    {
      description: `One card by id, plus its rate summaries, term ids, and fee records. ${SEED_NOTE}`,
      inputSchema: strictInput({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await getCard(db, args.id)),
  );

  server.registerTool(
    "get_term",
    {
      description: `One term by id: a condition on a card or rate (cap, exclusion, or another kind), with its text, source URL, and effective dates. ${SEED_NOTE}`,
      inputSchema: strictInput({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await getTerm(db, args.id)),
  );

  server.registerTool(
    "list_tags",
    {
      description: `Known spend tags (channel or category). ${SEED_NOTE}`,
      inputSchema: strictInput({ limit }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await listTags(db, args)),
  );

  server.registerTool(
    "resolve_alias",
    {
      description: `Map a free-text name to tag ids and card ids. No match returns an empty list. ${SEED_NOTE}`,
      inputSchema: strictInput({ query: z.string(), limit }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await resolveAlias(db, args)),
  );

  server.registerTool(
    "search_terms",
    {
      description: `EXPERIMENTAL — semantic discovery of relevant terms by free-text query (e.g. 粵語 descriptions of a condition). Returns candidates revalidated against D1: detail "terms" (default) returns the terms, "candidates" returns compact {term_id, card_id, kind, similarity} pointers for a get_term follow-up. Every hit carries similarity — a raw retrieval score, not a confidence measure; no calibrated cutoff exists, and low-scored hits may be plausible-sounding noise. min_similarity (0-1) is an optional caller-side floor, not a relevance guarantee. A hit means "possibly relevant", never that the term applies to a spend; an empty answer means nothing survived revalidation. ${SEED_NOTE}`,
      inputSchema: strictInput({
        query: z.string(),
        card_id: z.string().optional(),
        as_of: z.string().optional(),
        detail: z.enum(["terms", "candidates"]).optional(),
        min_similarity: z.number().min(0).max(1).optional(),
        limit,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await searchTerms(db, searchDeps, args)),
  );

  server.registerTool(
    "score_candidates",
    {
      description: `Calculate rebate for a spend under explicit assumptions. Lists exclusions it could not check. Tag ids that do not resolve are echoed as unknown_tag_ids. A merchant that maps to no tag fails unmapped_merchant with the valid tag list — it is never guessed. Spend is amount_hkd, or amount + currency + assumptions.hkd_per_foreign_unit for non-HKD billing; merchant_outside_hk marks an HKD bill at a merchant outside Hong Kong (the cross-border fee class). Does not pick a winner. ${SEED_NOTE}`,
      inputSchema: strictInput({
        amount_hkd: z.number().optional(),
        amount: z.number().optional(),
        currency: z.string().optional(),
        tag_ids: z.array(z.string()).optional(),
        card_ids: z.array(z.string()).optional(),
        alias: z.string().optional(),
        merchant: z.string().optional(),
        merchant_outside_hk: z.boolean().optional(),
        as_of: z.string().optional(),
        assumptions: strictInput({
            month_to_date_rebate_hkd: z.number().nonnegative().optional(),
            month_to_date_spend_hkd: z.number().nonnegative().optional(),
            hkd_per_point: z.number().nonnegative().optional(),
            hkd_per_foreign_unit: z.number().positive().optional(),
            checked_exclusions: z.array(z.string()).optional(),
          })
          .optional(),
        limit,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await scoreCandidates(db, args)),
  );
}

// ADR 0016: intercept registerTool so every call site keeps its inferred
// args while each tool call emits one usage datapoint — arg key names only,
// never values. Patched once per server, before any registration.
export function trackServerTools(
  server: McpServer,
  usage: ToolUsage | undefined,
): void {
  if (!usage?.sink) return;
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: (args: unknown, ctx: unknown) => unknown,
  ) => unknown;
  server.registerTool = ((
    name: string,
    config: unknown,
    cb: (args: unknown, ctx: unknown) => unknown,
  ) =>
    register(name, config, (args, ctx) =>
      trackTool(usage, name, args, () => cb(args, ctx)),
    )) as unknown as McpServer["registerTool"];
}

export function buildServer(
  db: D1Database,
  searchDeps: TermSearchDeps | null = null,
  usage?: ToolUsage,
): McpServer {
  const server = new McpServer({ name: "cardex", version: "0.0.1" });
  trackServerTools(server, usage);
  registerReadTools(server, db, searchDeps);

  server.registerTool(
    "report_issue",
    {
      description: `Report a wrong or stale fact for the maintenance queue. Exactly one of card_id, rate_id, term_id plus field and claimed_value. Evidence URL helps triage. Do not include personal data. ${SEED_NOTE}`,
      inputSchema: strictInput({
        card_id: z.string().optional(),
        rate_id: z.string().optional(),
        term_id: z.string().optional(),
        field: z.string(),
        claimed_value: z.string(),
        evidence_url: z.string().optional(),
        note: z.string().optional(),
      }),
    },
    async (args) => payload(await reportIssue(db, args)),
  );

  return server;
}
