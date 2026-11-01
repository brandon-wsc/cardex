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
} from "./query.js";

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

function payload(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

const limit = z.number().int().optional();

// The six public read tools, shared between /mcp and /maintainer (ADR 0002 —
// the maintainer surface exposes fact reads plus its own write-lite tools).
// Every input schema is strict: an unrecognized key is an InvalidParams
// error, never a silently stripped filter.
export function registerReadTools(server: McpServer, db: D1Database): void {
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
      description: `One card by id, plus its rate summaries and term ids. ${SEED_NOTE}`,
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
    "score_candidates",
    {
      description: `Calculate rebate for a spend under explicit assumptions. Lists exclusions it could not check. Tag ids that do not resolve are echoed as unknown_tag_ids. Spend is amount_hkd, or amount + currency + assumptions.hkd_per_foreign_unit for non-HKD billing. Does not pick a winner. ${SEED_NOTE}`,
      inputSchema: strictInput({
        amount_hkd: z.number().optional(),
        amount: z.number().optional(),
        currency: z.string().optional(),
        tag_ids: z.array(z.string()).optional(),
        card_ids: z.array(z.string()).optional(),
        alias: z.string().optional(),
        merchant: z.string().optional(),
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

export function buildServer(db: D1Database): McpServer {
  const server = new McpServer({ name: "cardex", version: "0.0.1" });
  registerReadTools(server, db);

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
