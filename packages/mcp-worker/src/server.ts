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

export function buildServer(db: D1Database): McpServer {
  const server = new McpServer({ name: "cardex", version: "0.0.1" });

  server.registerTool(
    "lookup_rates",
    {
      description: `Rates for a tag, card, or issuer. Compact page. ${SEED_NOTE}`,
      inputSchema: z.object({
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
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await getCard(db, args.id)),
  );

  server.registerTool(
    "get_term",
    {
      description: `One term by id: a condition on a card or rate (cap, exclusion, or another kind), with its text, source URL, and effective dates. ${SEED_NOTE}`,
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await getTerm(db, args.id)),
  );

  server.registerTool(
    "list_tags",
    {
      description: `Known spend tags (channel or category). ${SEED_NOTE}`,
      inputSchema: z.object({ limit }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await listTags(db, args)),
  );

  server.registerTool(
    "resolve_alias",
    {
      description: `Map a free-text name to tag ids and card ids. No match returns an empty list. ${SEED_NOTE}`,
      inputSchema: z.object({ query: z.string(), limit }),
      annotations: { readOnlyHint: true },
    },
    async (args) => payload(await resolveAlias(db, args)),
  );

  server.registerTool(
    "score_candidates",
    {
      description: `Calculate rebate for a spend under explicit assumptions. Lists exclusions it could not check. Does not pick a winner. ${SEED_NOTE}`,
      inputSchema: z.object({
        amount_hkd: z.number(),
        tag_ids: z.array(z.string()).optional(),
        card_ids: z.array(z.string()).optional(),
        alias: z.string().optional(),
        merchant: z.string().optional(),
        as_of: z.string().optional(),
        assumptions: z
          .object({
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

  server.registerTool(
    "report_issue",
    {
      description: `Report a wrong or stale fact for the maintenance queue. Exactly one of card_id, rate_id, term_id plus field and claimed_value. Evidence URL helps triage. Do not include personal data. ${SEED_NOTE}`,
      inputSchema: z.object({
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
