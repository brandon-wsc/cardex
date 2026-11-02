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
import { getTerm } from "./query";

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
  it("accepts a well-formed update on a facts table", async () => {
    expect(
      await validatePatch(tenv.DB, {
        op: "update",
        table: "terms",
        id: "term_dbs_quota",
        set: { quota_n: 15000 },
      }),
    ).toEqual([]);
  });

  it("rejects a table outside the facts whitelist", async () => {
    const errors = await validatePatch(tenv.DB, {
      op: "update",
      table: "proposals",
      id: "prop_x",
      set: { status: "applied" },
    });
    expect(errors).toEqual([
      "'proposals' is outside the patchable facts whitelist",
    ]);
  });

  it("rejects a column outside the table whitelist", async () => {
    const errors = await validatePatch(tenv.DB, {
      op: "update",
      table: "terms",
      id: "term_dbs_quota",
      set: { bogus: 1 },
    });
    expect(errors).toEqual(["'bogus' is not a column of terms"]);
  });

  it("rejects insert missing required columns", async () => {
    const errors = await validatePatch(tenv.DB, {
      op: "insert",
      table: "rates",
      id: "rate_new",
      set: { card_id: "card_dbs" },
    });
    expect(errors).toContain("insert missing required 'kind'");
  });

  it("rejects update with an empty set and delete carrying a set", async () => {
    expect(
      await validatePatch(tenv.DB, { op: "update", table: "terms", id: "t", set: {} }),
    ).toEqual(["update requires a non-empty set"]);
    expect(
      await validatePatch(tenv.DB, {
        op: "delete",
        table: "terms",
        id: "t",
        set: { text: "x" },
      }),
    ).toEqual(["delete must not carry set"]);
  });

  it("requires key for update/delete on composite-pk tables", async () => {
    const missing = await validatePatch(tenv.DB, {
      op: "delete",
      table: "rate_tags",
      id: "rate_hsbc_dining+dining",
    });
    expect(missing).toEqual([
      "delete on rate_tags must name {rate_id, tag_id} to find the row",
    ]);

    expect(
      await validatePatch(tenv.DB, {
        op: "delete",
        table: "rate_tags",
        id: "rate_hsbc_dining+dining",
        key: { rate_id: "rate_hsbc_dining", tag_id: "dining" },
      }),
    ).toEqual([]);
  });

  it("requires composite pk columns inside set on insert", async () => {
    const errors = await validatePatch(tenv.DB, {
      op: "insert",
      table: "term_merchants",
      id: "term_x+KFC",
      set: { merchant: "KFC" },
    });
    expect(errors).toContain("insert missing required 'term_id'");
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
    const view = await getProposal(tenv.DB, res.proposal_id);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.proposal).toMatchObject({
      status: "pending",
      proposed_by: "maintainer",
    });
  });

  it("records the credential identity, not the caller-supplied name", async () => {
    const res = await proposeChange(tenv.DB, {
      ...good,
      proposed_by: "mallory",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const view = await getProposal(tenv.DB, res.proposal_id);
    if (!view.ok) return;
    expect(view.proposal).toMatchObject({ proposed_by: "maintainer" });
  });

  it("rejects when evidence_url is missing", async () => {
    const res = await proposeChange(tenv.DB, { ...good, evidence_url: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_proposal");
  });

  it("rejects a non-http(s) evidence_url", async () => {
    for (const evidence_url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/x",
      "not-a-url",
    ]) {
      const res = await proposeChange(tenv.DB, { ...good, evidence_url });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_proposal");
    }
  });

  it("rejects overlong free text and oversized patch lists", async () => {
    for (const input of [
      { summary: "s".repeat(501) },
      { excerpt: "e".repeat(4001) },
      { evidence_url: "https://example.com/" + "a".repeat(2048) },
    ]) {
      const res = await proposeChange(tenv.DB, { ...good, ...input });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_proposal");
    }

    const many = await proposeChange(tenv.DB, {
      ...good,
      patches: Array.from({ length: 51 }, () => good.patches[0]),
    });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toBe("invalid_proposal");
  });

  it("rejects new proposals once the pending queue is full", async () => {
    await tenv.DB.prepare(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100)
       INSERT INTO proposals (id, proposed_by, summary, evidence_url, patches, status, created_at)
       SELECT 'prop_fill_' || x, 'grokbot', 's', 'https://e/x', '[]', 'pending', ?1 FROM c`,
    )
      .bind(new Date().toISOString())
      .run();

    const res = await proposeChange(tenv.DB, good);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_proposal");
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
    expect(res.error).toBe("invalid_patch");
    expect(res.detail).toContain("nope");
  });
});

describe("listReports / listProposals / getProposal", () => {
  it("listReports returns the seeded quarantine row", async () => {
    const res = await listReports(tenv.DB, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reports.map((r) => r.id)).toEqual(["rpt_seed_001"]);
  });

  it("listReports pages by offset and reports the unfiltered total", async () => {
    await tenv.DB.batch(
      Array.from({ length: 60 }, (_, i) =>
        tenv.DB.prepare(
          `INSERT INTO reports (id, target_kind, target_id, field, ` +
            `claimed_value, reported_at) VALUES (?, 'card', 'card_dbs', ` +
            `'name', 'x', ?)`,
        ).bind(
          `rpt_fill_${i}`,
          `2026-10-10T${String(i % 24).padStart(2, "0")}:00:00Z`,
        ),
      ),
    );

    const first = await listReports(tenv.DB, { limit: 50 });
    expect(first.total).toBe(61);
    expect(first.reports).toHaveLength(50);

    const rest = await listReports(tenv.DB, { limit: 50, offset: 50 });
    expect(rest.total).toBe(61);
    expect(rest.reports).toHaveLength(11);
  });

  it("listReports keyset-pages past rows that arrive mid-export", async () => {
    await tenv.DB.batch(
      Array.from({ length: 60 }, (_, i) =>
        tenv.DB.prepare(
          `INSERT INTO reports (id, target_kind, target_id, field, ` +
            `claimed_value, reported_at) VALUES (?, 'card', 'card_dbs', ` +
            `'name', 'x', ?)`,
        ).bind(
          `rpt_fill_${String(i).padStart(3, "0")}`,
          `2026-10-10T00:00:${String(i).padStart(2, "0")}Z`,
        ),
      ),
    );

    const first = await listReports(tenv.DB, { limit: 50 });
    if (!first.ok) return;

    // A report lands between pages — the offset page would repeat the tail
    // row; the cursor page must not.
    await tenv.DB.prepare(
      `INSERT INTO reports (id, target_kind, target_id, field, ` +
        `claimed_value, reported_at) VALUES ('rpt_new', 'card', ` +
        `'card_dbs', 'name', 'x', '2027-01-01T00:00:00Z')`,
    ).run();

    const last = first.reports[first.reports.length - 1];
    const rest = await listReports(tenv.DB, {
      limit: 50,
      before: last.reported_at as string,
      beforeId: last.id as string,
    });
    expect(rest.total).toBe(62);
    expect(rest.reports.map((r) => r.id)).not.toContain(last.id);

    const seen = new Set([
      ...first.reports.map((r) => r.id),
      ...rest.reports.map((r) => r.id),
    ]);
    expect(seen.size).toBe(61);
    expect(seen.has("rpt_new")).toBe(false);
    expect(seen.has("rpt_seed_001")).toBe(true);
  });

  it("listProposals filters by status", async () => {
    const res = await listProposals(tenv.DB, { status: "pending" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposals.map((p) => p.id)).toEqual(["prop_seed_001"]);
    expect(res.proposals.every((p) => p.status === "pending")).toBe(true);
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
    if (!res.ok) expect(res.error).toBe("not_found");
  });

  it("shows the existing row as old on an insert that would collide", async () => {
    const proposed = await proposeChange(tenv.DB, {
      summary: "re-insert the dining tag",
      evidence_url: "https://example.invalid/evidence",
      patches: [
        {
          op: "insert" as const,
          table: "tags",
          id: "dining",
          set: { label: "Dining", kind: "category" },
        },
      ],
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const res = await getProposal(tenv.DB, proposed.proposal_id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.proposal.patches[0].old).toMatchObject({
      id: "dining",
      label: "Dining",
      kind: "category",
    });
  });
});

describe("decideProposal", () => {
  it("approve applies the patch and records the decider", async () => {
    const res = await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "approve",
      decided_by: "owner@cardex.dev",
    });
    expect(res.ok).toBe(true);

    // The applied write is observable through the public get_term tool.
    const term = await getTerm(tenv.DB, "term_dbs_quota");
    expect(term.ok).toBe(true);
    if (!term.ok) return;
    expect(term.term.quota_n).toBe(15000);
    expect(term.term.last_verified_at).toBe("2026-11-01");

    const prop = await getProposal(tenv.DB, "prop_seed_001");
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    expect(prop.proposal).toMatchObject({
      status: "applied",
      decided_by: "owner@cardex.dev",
      decided_at: expect.any(String),
    });
  });

  it("reject requires a decision note", async () => {
    const res = await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "reject",
      decided_by: "owner@cardex.dev",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("note_required");

    const ok = await decideProposal(tenv.DB, "prop_seed_001", {
      decision: "reject",
      decided_by: "owner@cardex.dev",
      note: "affiliate source, cannot verify",
    });
    expect(ok.ok).toBe(true);
    const prop = await getProposal(tenv.DB, "prop_seed_001");
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    expect(prop.proposal).toMatchObject({
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
    if (!again.ok) expect(again.error).toBe("already_decided");
  });

  it("fails cleanly when an insert target already exists", async () => {
    const proposed = await proposeChange(tenv.DB, {
      summary: "re-insert the dining tag",
      evidence_url: "https://example.invalid/evidence",
      patches: [
        {
          op: "insert" as const,
          table: "tags",
          id: "dining",
          set: { label: "Dining", kind: "category" },
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
    if (res.ok) return;
    expect(res.error).toBe("invalid_patch");
    // Contract: the failure names the colliding row, not a raw SQLITE dump.
    expect(res.detail).toContain("dining");

    const prop = await getProposal(tenv.DB, proposed.proposal_id);
    expect(prop.ok).toBe(true);
    if (prop.ok) expect(prop.proposal).toMatchObject({ status: "pending" });
  });

  it("fails cleanly on a duplicate insert inside one proposal", async () => {
    const proposed = await proposeChange(tenv.DB, {
      summary: "insert the same tag twice",
      evidence_url: "https://example.invalid/evidence",
      patches: [
        {
          op: "insert" as const,
          table: "tags",
          id: "japan",
          set: { label: "Japan spend", kind: "category" },
        },
        {
          op: "insert" as const,
          table: "tags",
          id: "japan",
          set: { label: "Japan spend", kind: "category" },
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
    if (res.ok) return;
    expect(res.error).toBe("invalid_patch");
    expect(res.detail).toContain("japan");
  });

  it("applies delete-then-insert of the same row in one proposal", async () => {
    const proposed = await proposeChange(tenv.DB, {
      summary: "re-link citi overseas fx fee term",
      evidence_url: "https://example.invalid/evidence",
      patches: [
        {
          op: "delete" as const,
          table: "rate_terms",
          id: "rate_citi_overseas+term_citi_fx_fee",
          key: { rate_id: "rate_citi_overseas", term_id: "term_citi_fx_fee" },
        },
        {
          op: "insert" as const,
          table: "rate_terms",
          id: "rate_citi_overseas+term_citi_fx_fee",
          set: { rate_id: "rate_citi_overseas", term_id: "term_citi_fx_fee" },
        },
      ],
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const res = await decideProposal(tenv.DB, proposed.proposal_id, {
      decision: "approve",
      decided_by: "owner@cardex.dev",
    });
    expect(res.ok).toBe(true);
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
    if (res.ok) return;
    expect(res.error).toBe("apply_failed");

    // Nothing from the failed batch is observable through get_term.
    for (const id of ["term_new_valid", "term_bad_fk"]) {
      const term = await getTerm(tenv.DB, id);
      expect(term.ok).toBe(false);
      if (!term.ok) expect(term.error).toBe("not_found");
    }

    const prop = await getProposal(tenv.DB, proposed.proposal_id);
    expect(prop.ok).toBe(true);
    if (prop.ok) expect(prop.proposal).toMatchObject({ status: "pending" });
  });
});
