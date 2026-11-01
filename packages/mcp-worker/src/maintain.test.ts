import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  decideProposal,
  getProposal,
  listProposals,
  listReports,
  proposeChange,
  validatePatch,
} from "./maintain";

// Specs for the maintenance surface in ADR 0002: structured patches only,
// propose ≠ apply, approve is atomic.
const tenv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  SEED_SQL: string;
};

beforeEach(async () => {
  await applyD1Migrations(tenv.DB, tenv.TEST_MIGRATIONS);
  const statements = tenv.SEED_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await tenv.DB.batch(statements.map((sql) => tenv.DB.prepare(sql)));
});

describe("validatePatch", () => {
  it("accepts a well-formed update on a facts table", () => {
    expect(
      validatePatch({
        op: "update",
        table: "terms",
        id: "term_dbs_quota",
        set: { quota_n: 15000 },
      }),
    ).toEqual([]);
  });

  it("rejects a table outside the facts whitelist", () => {
    const errors = validatePatch({
      op: "update",
      table: "proposals",
      id: "prop_x",
      set: { status: "applied" },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("table");
  });

  it("rejects a column outside the table whitelist", () => {
    const errors = validatePatch({
      op: "update",
      table: "terms",
      id: "term_dbs_quota",
      set: { bogus: 1 },
    });
    expect(errors.some((e) => e.includes("bogus"))).toBe(true);
  });

  it("rejects insert missing required columns", () => {
    const errors = validatePatch({
      op: "insert",
      table: "rates",
      id: "rate_new",
      set: { card_id: "card_dbs" },
    });
    expect(errors.some((e) => e.includes("kind"))).toBe(true);
  });

  it("rejects update with an empty set and delete carrying a set", () => {
    expect(
      validatePatch({ op: "update", table: "terms", id: "t", set: {} })
        .length,
    ).toBeGreaterThan(0);
    expect(
      validatePatch({
        op: "delete",
        table: "terms",
        id: "t",
        set: { text: "x" },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("requires key for update/delete on composite-pk tables", () => {
    const missing = validatePatch({
      op: "delete",
      table: "rate_tags",
      id: "rate_hsbc_dining+dining",
    });
    expect(missing.some((e) => e.includes("key"))).toBe(true);

    expect(
      validatePatch({
        op: "delete",
        table: "rate_tags",
        id: "rate_hsbc_dining+dining",
        key: { rate_id: "rate_hsbc_dining", tag_id: "dining" },
      }),
    ).toEqual([]);
  });

  it("requires composite pk columns inside set on insert", () => {
    const errors = validatePatch({
      op: "insert",
      table: "term_merchants",
      id: "term_x+KFC",
      set: { merchant: "KFC" },
    });
    expect(errors.some((e) => e.includes("term_id"))).toBe(true);
  });
});

describe("proposeChange", () => {
  const good = {
    proposed_by: "grokbot",
    summary: "DBS quota raised to 15,000",
    evidence_url: "https://example.invalid/evidence",
    excerpt: "the first 15,000 registered cardholders",
    patches: [
      {
        op: "update" as const,
        table: "terms",
        id: "term_dbs_quota",
        set: { quota_n: 15000 },
      },
    ],
  };

  it("inserts a pending proposal and returns its id", async () => {
    const res = await proposeChange(tenv.DB, good);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = await tenv.DB.prepare(
      "SELECT status, proposed_by FROM proposals WHERE id = ?",
    )
      .bind(res.proposal_id)
      .first();
    expect(row).toMatchObject({ status: "pending", proposed_by: "grokbot" });
  });

  it("rejects when evidence_url is missing", async () => {
    const res = await proposeChange(tenv.DB, { ...good, evidence_url: "" });
    expect(res.ok).toBe(false);
  });

  it("rejects when any patch fails validation", async () => {
    const res = await proposeChange(tenv.DB, {
      ...good,
      patches: [
        ...good.patches,
        { op: "update" as const, table: "nope", id: "x", set: { a: 1 } },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toContain("nope");
  });
});

describe("listReports / listProposals / getProposal", () => {
  it("listReports returns the seeded quarantine row", async () => {
    const res = await listReports(tenv.DB, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reports.map((r) => r.id)).toContain("rpt_seed_001");
  });

  it("listProposals filters by status", async () => {
    const res = await listProposals(tenv.DB, { status: "pending" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposals.map((p) => p.id)).toEqual(["prop_seed_001"]);
  });

  it("getProposal parses patches and joins the current row as old", async () => {
    const res = await getProposal(tenv.DB, "prop_seed_001");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposal.patches[0].op).toBe("update");
    const old = res.proposal.patches[0].old as { quota_n: number } | null;
    expect(old?.quota_n).toBe(10000);
  });

  it("getProposal returns not_found for an unknown id", async () => {
    const res = await getProposal(tenv.DB, "prop_nope");
    expect(res.ok).toBe(false);
  });
});

describe("decideProposal", () => {
  it("approve applies the patch and records the decider", async () => {
    const res = await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "approve",
      decided_by: "owner@cardex.dev",
    });
    expect(res.ok).toBe(true);

    const term = await tenv.DB.prepare(
      "SELECT quota_n, last_verified_at FROM terms WHERE id = 'term_dbs_quota'",
    ).first();
    expect(term).toMatchObject({ quota_n: 15000, last_verified_at: "2026-11-01" });

    const prop = await tenv.DB.prepare(
      "SELECT status, decided_by, decided_at FROM proposals WHERE id = 'prop_seed_001'",
    ).first();
    expect(prop).toMatchObject({ status: "applied", decided_by: "owner@cardex.dev" });
    expect(prop?.decided_at).toBeTruthy();
  });

  it("reject requires a decision note", async () => {
    const res = await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "reject",
      decided_by: "owner@cardex.dev",
    });
    expect(res.ok).toBe(false);

    const ok = await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "reject",
      decided_by: "owner@cardex.dev",
      note: "affiliate source, cannot verify",
    });
    expect(ok.ok).toBe(true);
    const prop = await tenv.DB.prepare(
      "SELECT status, decision_note FROM proposals WHERE id = 'prop_seed_001'",
    ).first();
    expect(prop).toMatchObject({
      status: "rejected",
      decision_note: "affiliate source, cannot verify",
    });
  });

  it("refuses to decide a proposal that is not pending", async () => {
    await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "reject",
      decided_by: "owner@cardex.dev",
      note: "no",
    });
    const again = await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "approve",
      decided_by: "owner@cardex.dev",
    });
    expect(again.ok).toBe(false);
  });

  it("rolls back the whole batch when one patch fails at apply", async () => {
    const proposed = await proposeChange(tenv.DB, {
      summary: "two-op proposal where the second violates FK",
      evidence_url: "https://example.invalid/evidence",
      patches: [
        {
          op: "insert" as const,
          table: "terms",
          id: "term_new_valid",
          set: {
            card_id: "card_dbs",
            kind: "quota",
            text: "valid insert",
          },
        },
        {
          op: "insert" as const,
          table: "terms",
          id: "term_bad_fk",
          set: {
            card_id: "card_ghost",
            kind: "quota",
            text: "violates the cards FK",
          },
        },
      ],
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const res = await decideProposal(tenv.DB, proposed.proposal_id, {
      decision: "approve",
      decided_by: "owner@cardex.dev",
    });
    expect(res.ok).toBe(false);

    const leaked = await tenv.DB.prepare(
      "SELECT id FROM terms WHERE id IN ('term_new_valid', 'term_bad_fk')",
    ).all();
    expect(leaked.results).toHaveLength(0);

    const prop = await tenv.DB.prepare(
      "SELECT status FROM proposals WHERE id = ?",
    )
      .bind(proposed.proposal_id)
      .first();
    expect(prop?.status).toBe("pending");
  });
});
