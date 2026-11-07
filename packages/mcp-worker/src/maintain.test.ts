import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import fc from "fast-check";
import {
  decideProposal,
  getProposal,
  listProposals,
  listReports,
  parsePatch,
  patchStatements,
  proposeChange,
  quoteSqlIdent,
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

// Property-based specs for the same ADR 0002 boundary: instead of naming
// example rows, these assert invariants over generated inputs — any table
// outside FACT_TABLES is refused, any non-column key is refused, and no key
// shape can locate a row it should not. FACT_TABLES is private to
// maintain.ts; drift between this mirror and the source fails loudly
// because a removed table starts failing the whitelist property.
describe("validatePatch invariants", () => {
  const FACT_TABLE_NAMES = [
    "alias_cards",
    "alias_tags",
    "aliases",
    "cards",
    "rate_tags",
    "rate_terms",
    "rates",
    "tags",
    "term_merchants",
    "terms",
  ] as const;

  const scalarArb = fc.oneof(fc.string(), fc.integer(), fc.constant(null));
  const scalarMapArb = fc.dictionary(fc.string(), scalarArb);

  const tableInfo = async (table: string) => {
    const { results } = await tenv.DB
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string; pk: number }>();
    return results;
  };
  const pkColumns = (rows: { name: string; pk: number }[]) =>
    rows
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);

  it("parsePatch accepts only scalar key/set maps, for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const p = parsePatch(raw);
        if (p === null) return;
        expect(["insert", "update", "delete"]).toContain(p.op);
        expect(typeof p.table).toBe("string");
        expect(typeof p.id).toBe("string");
        for (const m of [p.key, p.set]) {
          if (m === undefined) continue;
          expect(Array.isArray(m)).toBe(false);
          expect(
            Object.values(m).every(
              (v) =>
                v === null || typeof v === "string" || typeof v === "number",
            ),
          ).toBe(true);
        }
      }),
    );
  });

  it("rejects every table outside the facts whitelist", async () => {
    const outside = fc
      .string({ minLength: 1 })
      .filter((t) => !(FACT_TABLE_NAMES as readonly string[]).includes(t));
    await fc.assert(
      fc.asyncProperty(outside, async (table) => {
        const errors = await validatePatch(tenv.DB, {
          op: "update",
          table,
          id: "x",
          set: { a: 1 },
        });
        expect(errors).toEqual([
          `'${table}' is outside the patchable facts whitelist`,
        ]);
      }),
      { numRuns: 30 },
    );
  });

  it("rejects every set key that is not a real column", async () => {
    const columns = new Map<string, string[]>();
    for (const t of FACT_TABLE_NAMES) {
      columns.set(t, (await tableInfo(t)).map((r) => r.name));
    }
    const arb = fc.constantFrom(...FACT_TABLE_NAMES).chain((table) =>
      fc.record({
        table: fc.constant(table),
        op: fc.constantFrom("insert" as const, "update" as const),
        bogus: fc
          .string({ minLength: 1 })
          .filter((s) => !(columns.get(table) ?? []).includes(s)),
        set: scalarMapArb,
      }),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ({ table, op, bogus, set }) => {
        const errors = await validatePatch(tenv.DB, {
          op,
          table,
          id: "prop_x",
          set: { ...set, [bogus]: 1 },
        });
        expect(errors).toContain(`'${bogus}' is not a column of ${table}`);
      }),
      { numRuns: 50 },
    );
  });

  it("rejects updates that write a primary key column", async () => {
    const pks = new Map<string, string[]>();
    for (const t of FACT_TABLE_NAMES) {
      pks.set(t, pkColumns(await tableInfo(t)));
    }
    const arb = fc.constantFrom(...FACT_TABLE_NAMES).chain((table) =>
      fc.record({
        table: fc.constant(table),
        pk: fc.constantFrom(...(pks.get(table) ?? ["id"])),
        set: scalarMapArb,
      }),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ({ table, pk, set }) => {
        const cols = pks.get(table) ?? [];
        const errors = await validatePatch(tenv.DB, {
          op: "update",
          table,
          id: "row_x",
          key: Object.fromEntries(cols.map((c) => [c, "row_x"])),
          set: { ...set, [pk]: "changed" },
        });
        expect(errors).toContain(`cannot update primary key '${pk}'`);
      }),
      { numRuns: 30 },
    );
  });

  it("rejects update/delete when the key cannot locate the row", async () => {
    const pks = new Map<string, string[]>();
    for (const t of FACT_TABLE_NAMES) {
      pks.set(t, pkColumns(await tableInfo(t)));
    }
    const single = FACT_TABLE_NAMES.filter(
      (t) => (pks.get(t) ?? []).length === 1,
    );
    const composite = FACT_TABLE_NAMES.filter(
      (t) => (pks.get(t) ?? []).length > 1,
    );

    // Single-pk: a key naming a different id can never locate the row.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...single),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        async (table, id, other) => {
          fc.pre(other !== id);
          const pk = (pks.get(table) ?? [])[0];
          const errors = await validatePatch(tenv.DB, {
            op: "update",
            table,
            id,
            key: { [pk]: other },
            set: { x: 1 },
          });
          expect(errors).toContain("key does not match id");
        },
      ),
      { numRuns: 20 },
    );

    // Composite-pk: dropping any pk column leaves the row unfindable.
    const compositeArb = fc.constantFrom(...composite).chain((table) =>
      fc.record({
        table: fc.constant(table),
        drop: fc.constantFrom(...(pks.get(table) ?? [])),
      }),
    );
    await fc.assert(
      fc.asyncProperty(compositeArb, async ({ table, drop }) => {
        const cols = pks.get(table) ?? [];
        const key = Object.fromEntries(
          cols.filter((c) => c !== drop).map((c) => [c, "v"]),
        );
        const errors = await validatePatch(tenv.DB, {
          op: "delete",
          table,
          id: "x+y",
          key,
        });
        expect(errors).toContain(
          `delete on ${table} must name {${cols.join(", ")}} to find the row`,
        );
      }),
      { numRuns: 20 },
    );
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

// Model-based keyset spec: for any cursor, the page must equal the same
// (reported_at DESC, id DESC) ordering recomputed in JS over the live
// table — no duplicates, no gaps, regardless of timestamp collisions.
describe("listReports keyset invariants", () => {
  it("returns exactly the rows strictly after the cursor", async () => {
    const stamps = fc.sample(
      fc.constantFrom(
        "2026-09-30T00:00:00Z",
        "2026-10-01T00:00:00Z",
        "2026-10-02T00:00:00Z",
      ),
      40,
    );
    await tenv.DB.batch(
      stamps.map((ts, i) =>
        tenv.DB
          .prepare(
            `INSERT INTO reports (id, target_kind, target_id, field, ` +
              `claimed_value, reported_at) VALUES (?, 'card', 'card_dbs', ` +
              `'name', 'x', ?)`,
          )
          .bind(`rpt_pbt_${String(i).padStart(2, "0")}`, ts),
      ),
    );

    const { results: all } = await tenv.DB
      .prepare("SELECT id, reported_at FROM reports")
      .all<{ id: string; reported_at: string }>();
    const ordered = [...all].sort(
      (a, b) =>
        b.reported_at.localeCompare(a.reported_at) ||
        b.id.localeCompare(a.id),
    );

    const cursorArb = fc.oneof(
      fc
        .constantFrom(...all)
        .map((r) => ({ before: r.reported_at, beforeId: r.id })),
      fc.record({
        before: fc.constantFrom(
          "2026-09-30T00:00:00Z",
          "2026-10-01T00:00:00Z",
          "2026-10-02T00:00:00Z",
          "2026-11-01T00:00:00Z",
        ),
        beforeId: fc.string({ minLength: 1, maxLength: 12 }),
      }),
    );
    let nonEmpty = 0;
    await fc.assert(
      fc.asyncProperty(
        cursorArb,
        fc.integer({ min: 1, max: 60 }),
        async (cursor, limit) => {
          const res = await listReports(tenv.DB, {
            before: cursor.before,
            beforeId: cursor.beforeId,
            limit,
          });
          if (!res.ok) throw new Error("unreachable");
          const expected = ordered
            .filter(
              (r) =>
                r.reported_at < cursor.before ||
                (r.reported_at === cursor.before && r.id < cursor.beforeId),
            )
            .map((r) => r.id)
            .slice(0, limit);
          if (res.reports.length > 0) nonEmpty += 1;
          expect(res.reports.map((r) => r.id)).toEqual(expected);
        },
      ),
      { numRuns: 40 },
    );
    // Coverage floor: most cursors sit mid-table, so empty pages should
    // be the minority — a generator regression starving them is caught.
    expect(nonEmpty).toBeGreaterThanOrEqual(10);
  });

  it("without beforeId the cursor falls back to the timestamp alone", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "2026-10-01T00:00:00Z",
          "2026-10-02T00:00:00Z",
          "2026-10-10T00:00:00Z",
        ),
        async (before) => {
          const res = await listReports(tenv.DB, { before, limit: 100 });
          if (!res.ok) throw new Error("unreachable");
          expect(
            res.reports.every((r) => (r.reported_at as string) < before),
          ).toBe(true);
        },
      ),
      { numRuns: 10 },
    );
  });
});

describe("listProposals invariants", () => {
  it("returns only the requested status, newest first, capped by limit", async () => {
    const statuses = ["pending", "applied", "rejected"] as const;
    await tenv.DB.batch(
      Array.from({ length: 12 }, (_, i) =>
        tenv.DB
          .prepare(
            `INSERT INTO proposals (id, proposed_by, summary, evidence_url, ` +
              `patches, status, created_at) VALUES (?, 'm', 's', ` +
              `'https://e/x', '[]', ?, ?)`,
          )
          .bind(
            `prop_pbt_${String(i).padStart(2, "0")}`,
            statuses[i % 3],
            `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          ),
      ),
    );
    const { results: all } = await tenv.DB
      .prepare("SELECT id, status, created_at FROM proposals")
      .all<{ id: string; status: string; created_at: string }>();

    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc.constantFrom("pending", "applied", "rejected", "bogus"),
          { nil: undefined },
        ),
        fc.integer({ min: -5, max: 150 }),
        async (status, limit) => {
          const res = await listProposals(tenv.DB, { status, limit });
          if (!res.ok) return;
          const pageLimit = Math.min(Math.max(limit, 1), 100);
          const expected = all
            .filter((r) => status === undefined || r.status === status)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, pageLimit)
            .map((r) => r.id);
          expect(res.proposals.map((p) => p.id)).toEqual(expected);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// Defense in depth for the apply path: validatePatch whitelists identifiers,
// and patchStatements quotes them so a skipped-validation caller fails
// closed instead of executing a smuggled fragment. TableSpec is private, so
// the spec is rebuilt from the same PRAGMA the source reads.
describe("patchStatements identifier quoting", () => {
  const specFor = async (table: string) => {
    const { results } = await tenv.DB
      .prepare(`PRAGMA table_info(${table})`)
      .all<{
        name: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>();
    const pk = results
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    const nonKeyRequired = results
      .filter((r) => r.notnull === 1 && r.dflt_value === null && r.pk === 0)
      .map((r) => r.name);
    return {
      pk,
      required: [...pk, ...nonKeyRequired],
      columns: results.map((r) => r.name),
    };
  };

  it("quoteSqlIdent wraps identifiers and escapes embedded quotes", () => {
    expect(quoteSqlIdent("quota_n")).toBe('"quota_n"');
    expect(quoteSqlIdent('quota"n')).toBe('"quota""n"');
  });

  it("quotes the table and column identifiers in a generated INSERT", async () => {
    const spec = await specFor("terms");
    const [stmt] = patchStatements(
      {
        op: "insert",
        table: "terms",
        id: "term_new",
        set: { card_id: "card_dbs", kind: "quota", text: "t" },
      },
      spec,
    );
    expect(stmt.sql).toBe(
      'INSERT INTO "terms" ("card_id", "id", "kind", "text") ' +
        "VALUES (?, ?, ?, ?)",
    );
    expect(stmt.params).toEqual(["card_dbs", "term_new", "quota", "t"]);
  });

  it("quotes identifiers in generated UPDATE and DELETE", async () => {
    const spec = await specFor("terms");
    const [upd] = patchStatements(
      {
        op: "update",
        table: "terms",
        id: "term_dbs_quota",
        set: { quota_n: 1 },
      },
      spec,
    );
    expect(upd.sql).toBe(
      'UPDATE "terms" SET "quota_n" = ? WHERE "id" = ?',
    );
    expect(upd.params).toEqual([1, "term_dbs_quota"]);

    const [del] = patchStatements(
      { op: "delete", table: "terms", id: "term_dbs_quota" },
      spec,
    );
    expect(del.sql).toBe('DELETE FROM "terms" WHERE "id" = ?');
    expect(del.params).toEqual(["term_dbs_quota"]);
  });

  it("quotes every pk column in the WHERE of a composite-key patch", async () => {
    const spec = await specFor("rate_tags");
    const [del] = patchStatements(
      {
        op: "delete",
        table: "rate_tags",
        id: "rate_hsbc_dining+dining",
        key: { rate_id: "rate_hsbc_dining", tag_id: "dining" },
      },
      spec,
    );
    expect(del.sql).toBe(
      'DELETE FROM "rate_tags" WHERE "rate_id" = ? AND "tag_id" = ?',
    );
    expect(del.params).toEqual(["rate_hsbc_dining", "dining"]);
  });

  it("turns a bogus set key into an inert quoted identifier", async () => {
    const spec = await specFor("terms");
    const [stmt] = patchStatements(
      {
        op: "update",
        table: "terms",
        id: "term_dbs_quota",
        set: { "quota_n = 0, kind": 1 },
      },
      spec,
    );
    // The whole bogus key is one quoted identifier — no `=` escapes it.
    expect(stmt.sql).toBe(
      'UPDATE "terms" SET "quota_n = 0, kind" = ? WHERE "id" = ?',
    );
    // Fails closed against the real database instead of applying.
    await expect(
      tenv.DB.prepare(stmt.sql)
        .bind(...stmt.params)
        .run(),
    ).rejects.toThrow();
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
