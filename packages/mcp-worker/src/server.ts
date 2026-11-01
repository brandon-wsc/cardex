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
      description: `Rates for a tag, card, or issuer. Requires at least one of tag_id, card_ids, issuer — a filter-less call returns missing_filter instead of the catalog. issuer matches exactly or through known issuer aliases, and the response echoes the applied filters. Compact page. ${SEED_NOTE}`,
      inputSchema: z.strictObject({
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
      inputSchema: z.strictObject({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await getCard(db, args.id)),
  );

  server.registerTool(
    "get_term",
    {
      description: `One term by id: a condition on a card or rate (cap, exclusion, or another kind), with its text, source URL, and effective dates. ${SEED_NOTE}`,
      inputSchema: z.strictObject({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await getTerm(db, args.id)),
  );

  server.registerTool(
    "list_tags",
    {
      description: `Known spend tags (channel or category). ${SEED_NOTE}`,
      inputSchema: z.strictObject({ limit }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await listTags(db, args)),
  );

  server.registerTool(
    "resolve_alias",
    {
      description: `Map a free-text name to tag ids and card ids. No match returns an empty list. ${SEED_NOTE}`,
      inputSchema: z.strictObject({ query: z.string(), limit }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await resolveAlias(db, args)),
  );

  server.registerTool(
    "score_candidates",
    {
      description: `Calculate rebate for a spend under explicit assumptions. Lists exclusions it could not check. Tag ids that do not resolve are echoed as unknown_tag_ids. Does not pick a winner. ${SEED_NOTE}`,
      inputSchema: z.strictObject({
        amount_hkd: z.number(),
        tag_ids: z.array(z.string()).optional(),
        card_ids: z.array(z.string()).optional(),
        alias: z.string().optional(),
        merchant: z.string().optional(),
        as_of: z.string().optional(),
        assumptions: z
          .strictObject({
            month_to_date_rebate_hkd: z.number().nonnegative().optional(),
            month_to_date_spend_hkd: z.number().nonnegative().optional(),
            hkd_per_point: z.number().nonnegative().optional(),
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
      inputSchema: z.strictObject({
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
