import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import fc from "fast-check";
import { ISSUER_ALIASES, NETWORK_ALIASES } from "./aliases";
import { listReports } from "./maintain";
import {
  applyLimit,
  getCard,
  getTerm,
  isHttpUrl,
  listTags,
  lookupRates,
  reportIssue,
  resolveAlias,
  scoreCandidates,
} from "./query";

// Specs are sourced from PRD §4–§6: one table row, one test.
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

// JS re-implementation of the aliasHits rule in query.ts — the property
// specs below use it as the model the SQL/JS production path must match.
const normText = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const aliasContain = (q: string, a: string) => {
  const x = normText(q);
  const y = normText(a);
  if (!x || !y) return false;
  if (x === y) return true;
  if ([...x].length < 2 || [...y].length < 2) return false;
  return x.includes(y) || y.includes(x);
};

describe("lookup_rates", () => {
  it("returns matching rates for a tag", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining", limit: 100 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.records.map((r) => r.rate_id);
    expect(ids).toContain("rate_hsbc_dining");
    expect(ids).toContain("rate_aeon_dining");
    // A page under max limit is the whole match set — total counts it all.
    expect(res.records).toHaveLength(res.total);
  });

  it("ANDs tag, card and issuer filters", async () => {
    const byCard = await lookupRates(tenv.DB, {
      tag_id: "dining",
      card_ids: ["card_hsbc_red"],
    });
    expect(byCard.ok && byCard.records).toHaveLength(1);
    if (byCard.ok) expect(byCard.records[0].rate_id).toBe("rate_hsbc_dining");

    const byIssuer = await lookupRates(tenv.DB, {
      tag_id: "dining",
      issuer: "hsbc",
    });
    expect(byIssuer.ok).toBe(true);
    if (byIssuer.ok) {
      expect(byIssuer.records.map((r) => r.rate_id)).toEqual(["rate_hsbc_dining"]);
      expect(byIssuer.records.every((r) => r.issuer === "HSBC")).toBe(true);
      expect(byIssuer.filters.issuer_canonical).toEqual(["HSBC"]);
    }
  });

  it("returns an empty page with unknown_tag_id for an unknown tag", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "nope" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.records).toEqual([]);
    expect(res.total).toBe(0);
    expect((res as { unknown_tag_id?: string }).unknown_tag_id).toBe("nope");
  });

  it("defaults limit to 5 and echoes no limit_requested", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limit).toBe(5);
    expect(res.limit_requested).toBeNull();
    expect(res.clamped).toBe(false);
  });

  it("clamps limit above 100 and echoes limit_requested", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining", limit: 200 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limit).toBe(100);
    expect(res.limit_requested).toBe(200);
    expect(res.clamped).toBe(true);
  });

  it("rejects a non-integer or sub-1 limit with invalid_limit", async () => {
    for (const limit of [0, -3, 1.5]) {
      const res = await lookupRates(tenv.DB, { limit });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_limit");
    }
  });

  it("reports total as the pre-limit count", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining", limit: 1 });
    const full = await lookupRates(tenv.DB, { tag_id: "dining", limit: 100 });
    expect(res.ok && full.ok).toBe(true);
    if (!res.ok || !full.ok) return;
    expect(res.records).toHaveLength(1);
    expect(res.total).toBe(full.records.length);
    expect(res.total).toBe(full.total);
  });
});

describe("get_card", () => {
  it("returns a card with its rates and cited term ids", async () => {
    const res = await getCard(tenv.DB, "card_hsbc_red");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.name).toBe("HSBC Red Credit Card");
    expect(res.rates.map((r) => r.rate_id).sort()).toEqual(
      ["rate_hsbc_dining", "rate_hsbc_online"].sort(),
    );
    expect(res.term_ids).toEqual(
      expect.arrayContaining(["term_hsbc_dining_cap", "term_hsbc_octopus"]),
    );
    expect(res.term_ids).not.toContain("term_dbs_quota");
  });

  it("returns not_found for an unknown id", async () => {
    const res = await getCard(tenv.DB, "card_nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("not_found");
  });
});

describe("get_term", () => {
  it("returns the term", async () => {
    const res = await getTerm(tenv.DB, "term_hsbc_dining_cap");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.term.kind).toBe("cap");
    expect(res.term.cap_hkd).toBe(300);
    expect(res.term.period).toBe("statement_month");
  });

  it("returns not_found for an unknown id", async () => {
    const res = await getTerm(tenv.DB, "term_nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("not_found");
  });
});

describe("list_tags", () => {
  it("returns tags honoring limit and total", async () => {
    const all = await listTags(tenv.DB, { limit: 100 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.records).toHaveLength(all.total);
    expect(all.records.map((t) => t.id)).toEqual(
      expect.arrayContaining(["dining", "online", "overseas", "supermarket"]),
    );

    const one = await listTags(tenv.DB, { limit: 1 });
    expect(one.ok && one.records).toHaveLength(1);
    if (one.ok) expect(one.total).toBe(all.total);
  });
});

describe("resolve_alias", () => {
  it("resolves a merchant alias to its tags", async () => {
    const res = await resolveAlias(tenv.DB, { query: "茶餐廳" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hit = res.matches.find((m) => m.text === "茶餐廳");
    expect(hit?.tag_ids).toContain("dining");
  });

  it("resolves spoken dining merchant names to the dining tag", async () => {
    // Hero-demo merchants (BRA-22): the names a caller passes as said.
    for (const query of ["譚仔", "TamJai", "壽司郎"]) {
      const res = await resolveAlias(tenv.DB, { query });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const dining = res.matches.find((m) => m.tag_ids.includes("dining"));
      expect(dining, `expected a dining match for ${query}`).toBeDefined();
    }
  });

  it("resolves a card nickname and contains-matches a longer query", async () => {
    const exact = await resolveAlias(tenv.DB, { query: "hsbc red" });
    const cardHit = exact.ok
      ? exact.matches.find((m) => m.text === "hsbc red")
      : undefined;
    expect(cardHit?.card_ids).toContain("card_hsbc_red");

    const contains = await resolveAlias(tenv.DB, { query: "red" });
    expect(contains.ok).toBe(true);
    if (contains.ok) {
      expect(contains.matches.map((m) => m.text)).toContain("hsbc red");
    }
  });

  it("returns an empty matches array when nothing hits", async () => {
    const res = await resolveAlias(tenv.DB, { query: "八達通" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.matches).toEqual([]);
  });

  it("resolves a CJK issuer name to the canonical issuer string", async () => {
    const res = await resolveAlias(tenv.DB, { query: "匯豐" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hit = res.matches.find((m) => m.text === "匯豐");
    expect(hit?.issuers).toContain("HSBC");
  });

  it("shows both readings of an ambiguous issuer query", async () => {
    // "hsbc" hits the exact issuer alias AND the longer "hsbc red" card
    // alias — the caller sees both candidates instead of a silent pick.
    const res = await resolveAlias(tenv.DB, { query: "hsbc" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const issuerHit = res.matches.find((m) => m.text === "hsbc");
    const cardHit = res.matches.find((m) => m.text === "hsbc red");
    expect(issuerHit?.issuers).toContain("HSBC");
    expect(cardHit?.card_ids).toContain("card_hsbc_red");
  });

  it("resolves a CJK network name to the canonical network string", async () => {
    const res = await resolveAlias(tenv.DB, { query: "銀聯" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hit = res.matches.find((m) => m.text === "銀聯");
    expect(hit?.networks).toContain("unionpay");
  });
});

describe("score_candidates", () => {
  it("rejects a non-positive amount with invalid_amount", async () => {
    for (const amount_hkd of [0, -100]) {
      const res = await scoreCandidates(tenv.DB, { amount_hkd, tag_ids: ["dining"] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_amount");
    }
  });

  it("rejects a spend with no tags or usable alias as missing_spend", async () => {
    const res = await scoreCandidates(tenv.DB, { amount_hkd: 800 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("missing_spend");

    const badAlias = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      alias: "八達通",
    });
    expect(badAlias.ok).toBe(false);
  });

  it("clarifies an unmapped merchant instead of generic missing_spend", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 4700,
      merchant: "GoogaVision",
    });
    // The merchant is echoed and the caller gets the real tag vocabulary —
    // Cardex never guesses the spend's category for it.
    expect(res).toMatchObject({
      ok: false,
      error: "unmapped_merchant",
      merchant: "GoogaVision",
      valid_tag_ids: expect.arrayContaining(["online", "dining"]),
    });
  });

  it("keeps missing_spend when the call has no merchant either", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 4700,
      card_ids: ["card_aeon"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("missing_spend");
  });

  it("calculates rebate as amount × value / 100", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    const aeon = res.candidates.find((c) => c.rate_id === "rate_aeon_dining");
    expect(hsbc?.calculated_rebate_hkd).toBe(64);
    expect(aeon?.calculated_rebate_hkd).toBe(24);
  });

  it("returns null and flags points_value when hkd_per_point is absent", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const points = res.candidates.find((c) => c.rate_id === "rate_scb_overseas");
    expect(points?.calculated_rebate_hkd).toBeNull();
    expect(points?.unknown_exclusions).toContain("points_value");
  });

  it("values points with hkd_per_point when supplied", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
      assumptions: { hkd_per_point: 0.05 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const points = res.candidates.find((c) => c.rate_id === "rate_scb_overseas");
    expect(points?.calculated_rebate_hkd).toBe(50);
    expect(points?.unknown_exclusions).not.toContain("points_value");
  });

  it("flags cap_remaining when month-to-date is absent", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(hsbc?.unknown_exclusions).toContain(
      "cap_remaining:term_hsbc_dining_cap",
    );
    expect(hsbc?.calculated_rebate_hkd).toBe(64);
  });

  it("clamps to the remaining cap when month-to-date is present", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: { month_to_date_rebate_hkd: 250 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(hsbc?.calculated_rebate_hkd).toBe(50);
    expect(hsbc?.unknown_exclusions).not.toContain(
      "cap_remaining:term_hsbc_dining_cap",
    );
  });

  it("lists unchecked exclusions and hides checked ones", async () => {
    const unchecked = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    const hsbcU = unchecked.ok
      ? unchecked.candidates.find((c) => c.rate_id === "rate_hsbc_dining")
      : undefined;
    expect(hsbcU?.unknown_exclusions).toContain("octopus_topup");

    const checked = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: { checked_exclusions: ["octopus_topup"] },
    });
    const hsbcC = checked.ok
      ? checked.candidates.find((c) => c.rate_id === "rate_hsbc_dining")
      : undefined;
    expect(hsbcC?.unknown_exclusions).not.toContain("octopus_topup");
  });

  it("orders rows by card_id then rate_id", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.card_id)).toEqual([
      "card_aeon",
      "card_dbs",
      "card_dbs",
      "card_hsbc_red",
    ]);
  });

  it("echoes the assumptions it used", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: {
        month_to_date_rebate_hkd: 250,
        checked_exclusions: ["octopus_topup"],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates[0];
    expect(row.assumptions_used.month_to_date_rebate_hkd).toBe(250);
    expect(row.assumptions_used.checked_exclusions).toContain("octopus_topup");
    expect(row.assumptions_used.hkd_per_point).toBeNull();
  });

  it("resolves a spend from an alias as well as tag_ids", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      alias: "茶餐廳",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tag_ids).toContain("dining");
    expect(res.candidates.length).toBeGreaterThan(0);
  });
});

// PRD v0.3 contract deltas — landed with the tests that gated them.
describe("contract deltas — PRD v0.3", () => {
  it("returns the requested limit between 21 and 100", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining", limit: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limit).toBe(50);
    expect(res.clamped).toBe(false);
  });

  it("filters rates by card_ids for the held-set path", async () => {
    const res = await lookupRates(tenv.DB, { card_ids: ["card_hsbc_red"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.records.length).toBeGreaterThan(0);
    expect(res.records.every((r) => r.card_id === "card_hsbc_red")).toBe(true);
    expect(res.records.map((r) => r.rate_id)).toEqual(
      expect.arrayContaining(["rate_hsbc_dining", "rate_hsbc_online"]),
    );
    expect(res.total).toBeGreaterThanOrEqual(res.records.length);
  });

  it("restricts scored rows to confirmed card_ids", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      card_ids: ["card_hsbc_red"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates.every((c) => c.card_id === "card_hsbc_red")).toBe(
      true,
    );
  });

  it("echoes unit on each rate row", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const row of res.records) {
      expect(typeof row.unit).toBe("string");
    }
    const overseas = await lookupRates(tenv.DB, { tag_id: "overseas" });
    const points = overseas.ok
      ? overseas.records.find((r) => r.rate_id === "rate_scb_overseas")
      : undefined;
    expect(points?.unit).toBe("points_per_hkd");
  });

  it("echoes seed_as_of on the envelope", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining" });
    expect(res.ok && res.seed_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("narrows the scored set by card hits from an alias", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      alias: "hsbc red",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates.every((c) => c.card_id === "card_hsbc_red")).toBe(
      true,
    );
  });

  it("filters terms outside their effective window by as_of", async () => {
    const today = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
    });
    expect(today.ok).toBe(true);
    if (!today.ok) return;
    const citi = today.candidates.find((c) => c.rate_id === "rate_citi_overseas");
    expect(citi?.unknown_exclusions).toContain(
      "term_outside_window:term_citi_expired_cap",
    );

    // Same score dated inside the promo window: the cap is applied, not skipped.
    const feb = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
      as_of: "2026-02-01",
    });
    expect(feb.ok).toBe(true);
    if (!feb.ok) return;
    const citiFeb = feb.candidates.find((c) => c.rate_id === "rate_citi_overseas");
    expect(citiFeb?.unknown_exclusions).toContain(
      "cap_remaining:term_citi_expired_cap",
    );
    expect(citiFeb?.unknown_exclusions).not.toContain(
      "term_outside_window:term_citi_expired_cap",
    );
  });

  it("surfaces fx_fee terms until the caller settles them", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const citi = res.candidates.find((c) => c.rate_id === "rate_citi_overseas");
    expect(citi?.unknown_exclusions).toContain("fx_fee:term_citi_fx_fee");

    const settled = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
      assumptions: { checked_exclusions: ["fx_fee:term_citi_fx_fee"] },
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    const citiSettled = settled.candidates.find(
      (c) => c.rate_id === "rate_citi_overseas",
    );
    expect(citiSettled?.unknown_exclusions).not.toContain(
      "fx_fee:term_citi_fx_fee",
    );
  });

  it("writes report_issue to the quarantined reports table", async () => {
    const res = await reportIssue(tenv.DB, {
      rate_id: "rate_hsbc_dining",
      field: "value",
      claimed_value: "6",
      evidence_url: "https://example.com/hsbc-terms",
      note: "illustrative report",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report_id).toMatch(/^rpt_/);

    // Re-read through the maintenance surface: the report lands in
    // quarantine for triage, never in a query-tool payload.
    const list = await listReports(tenv.DB, {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = list.reports.find((r) => r.id === res.report_id);
    expect(row).toMatchObject({
      target_kind: "rate",
      field: "value",
      claimed_value: "6",
    });
  });

  it("rejects a report missing target, field, or claimed_value", async () => {
    const noTarget = await reportIssue(tenv.DB, {
      field: "value",
      claimed_value: "6",
    });
    expect(noTarget.ok).toBe(false);
    if (!noTarget.ok) expect(noTarget.error).toBe("invalid_report");

    const twoTargets = await reportIssue(tenv.DB, {
      card_id: "card_hsbc_red",
      rate_id: "rate_hsbc_dining",
      field: "value",
      claimed_value: "6",
    });
    expect(twoTargets.ok).toBe(false);

    const noField = await reportIssue(tenv.DB, { card_id: "card_hsbc_red" });
    expect(noField.ok).toBe(false);
  });

  it("returns not_found for a report on an unknown target", async () => {
    const res = await reportIssue(tenv.DB, {
      card_id: "card_nope",
      field: "name",
      claimed_value: "X",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("not_found");
  });

  it("rejects a report with a non-http(s) or overlong evidence_url", async () => {
    for (const evidence_url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/x",
      "not-a-url",
      "https://example.com/" + "a".repeat(2048),
    ]) {
      const res = await reportIssue(tenv.DB, {
        card_id: "card_hsbc_red",
        field: "value",
        claimed_value: "6",
        evidence_url,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_report");
    }
  });

  it("accepts http(s) evidence_url but rejects overlong free text", async () => {
    const ok = await reportIssue(tenv.DB, {
      card_id: "card_hsbc_red",
      field: "value",
      claimed_value: "6",
      evidence_url: "http://example.com/terms",
    });
    expect(ok.ok).toBe(true);

    for (const input of [
      { field: "f".repeat(101) },
      { claimed_value: "c".repeat(501) },
      { note: "n".repeat(2001) },
    ]) {
      const res = await reportIssue(tenv.DB, {
        card_id: "card_hsbc_red",
        field: "value",
        claimed_value: "6",
        ...input,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_report");
    }
  });

  it("rejects new reports once the daily intake cap is hit", async () => {
    await tenv.DB.prepare(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 500)
       INSERT INTO reports (id, target_kind, target_id, field, claimed_value, reported_at)
       SELECT 'rpt_fill_' || x, 'card', 'card_hsbc_red', 'f', 'v', ?1 FROM c`,
    )
      .bind(new Date().toISOString())
      .run();

    const res = await reportIssue(tenv.DB, {
      card_id: "card_hsbc_red",
      field: "value",
      claimed_value: "6",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_report");
  });
});

// PRD v0.4 contract deltas — silent-footgun hardening. A filter-less or
// mistyped call must surface as an error or an explicit flag, never as a
// quiet catalog dump.
describe("contract deltas — PRD v0.4", () => {
  it("rejects a filter-less lookup_rates call with missing_filter", async () => {
    for (const input of [{}, { limit: 5 }, { card_ids: [] }]) {
      const res = await lookupRates(tenv.DB, input);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("missing_filter");
    }
  });

  it("does not substring-match issuer, so a stray letter hits nothing", async () => {
    // Old behaviour was substring instr(): issuer:"a" matched AEON + Amex +
    // anything containing the letter. Canonical-or-alias resolution returns
    // an honest empty page.
    const res = await lookupRates(tenv.DB, { issuer: "a" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(0);
    expect(res.records).toEqual([]);
  });

  it("resolves an issuer through the alias map to the canonical string", async () => {
    const zh = await lookupRates(tenv.DB, { issuer: "匯豐" });
    expect(zh.ok).toBe(true);
    if (!zh.ok) return;
    expect(zh.total).toBe(2);
    expect(zh.records.every((r) => r.issuer === "HSBC")).toBe(true);
    expect(zh.filters.issuer_canonical).toEqual(["HSBC"]);

    const abbr = await lookupRates(tenv.DB, { issuer: "sc" });
    expect(abbr.ok).toBe(true);
    if (!abbr.ok) return;
    expect(abbr.records.every((r) => r.issuer === "Standard Chartered")).toBe(
      true,
    );
  });

  it("echoes the filters actually applied", async () => {
    const res = await lookupRates(tenv.DB, {
      tag_id: "online",
      card_ids: ["card_hsbc_red"],
      issuer: "hsbc",
      as_of: "2026-11-01",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.filters).toEqual({
      tag_id: "online",
      card_ids: ["card_hsbc_red"],
      issuer: "hsbc",
      issuer_canonical: ["HSBC"],
      as_of: "2026-11-01",
    });

    const sparse = await lookupRates(tenv.DB, { tag_id: "dining" });
    expect(sparse.ok).toBe(true);
    if (!sparse.ok) return;
    expect(sparse.filters.tag_id).toBe("dining");
    expect(sparse.filters.card_ids).toBeNull();
    expect(sparse.filters.issuer).toBeNull();
    expect(sparse.filters.issuer_canonical).toBeNull();
  });

  it("echoes filters on the unknown_tag_id page too", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "nope" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.filters.tag_id).toBe("nope");
    expect((res as { unknown_tag_id?: string }).unknown_tag_id).toBe("nope");
  });

  it("flags unknown tag_ids on score_candidates while scoring the rest", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining", "bogus"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res as { unknown_tag_ids?: string[] }).unknown_tag_ids).toEqual([
      "bogus",
    ]);
    expect(res.tag_ids).toEqual(["dining", "bogus"]);
    expect(res.candidates.length).toBe(4);
  });

  it("returns ok with empty candidates when every tag is unknown", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["bogus"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(0);
    expect(res.candidates).toEqual([]);
    expect((res as { unknown_tag_ids?: string[] }).unknown_tag_ids).toEqual([
      "bogus",
    ]);
  });

  it("omits unknown_tag_ids when every tag resolves", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).not.toHaveProperty("unknown_tag_ids");
  });
});

// Term-kind audit kinds — docs/term-kind-audit.md. Surface-only kinds ride the
// generic settle-me path; min_spend, merchant_list and exclusive_group get
// real behaviour because the caller supplies enough input to check them.
describe("audit-driven term kinds", () => {
  const SURFACE_CASES = [
    ["quota", "term_dbs_quota", "rate_dbs_dining_high", "dining"],
    ["targeted", "term_scb_targeted", "rate_scb_overseas", "overseas"],
    ["eligibility", "term_scb_eligibility", "rate_scb_overseas", "overseas"],
    ["geo", "term_citi_geo", "rate_citi_overseas", "overseas"],
    ["registration_required", "term_hsbc_register", "rate_hsbc_online", "online"],
  ] as const;

  it.each(SURFACE_CASES)(
    "surfaces %s:%s in unknown_exclusions until the caller settles it",
    async (kind, termId, rateId, tag) => {
      const res = await scoreCandidates(tenv.DB, {
        amount_hkd: 800,
        tag_ids: [tag],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const row = res.candidates.find((c) => c.rate_id === rateId);
      expect(row?.unknown_exclusions).toContain(`${kind}:${termId}`);

      const settled = await scoreCandidates(tenv.DB, {
        amount_hkd: 800,
        tag_ids: [tag],
        assumptions: { checked_exclusions: [`${kind}:${termId}`] },
      });
      const row2 = settled.ok
        ? settled.candidates.find((c) => c.rate_id === rateId)
        : undefined;
      expect(row2?.unknown_exclusions).not.toContain(`${kind}:${termId}`);
    },
  );

  it("clears per-transaction min_spend when the amount meets the threshold", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_dbs_dining_high")
      : undefined;
    expect(row?.failed_terms).not.toContain("min_spend_unmet:term_dbs_min_spend");
    expect(row?.unknown_exclusions).not.toContain("min_spend:term_dbs_min_spend");
  });

  it("returns null and flags min_spend_unmet when amount is below the per-transaction threshold", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 100,
      tag_ids: ["dining"],
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_dbs_dining_high")
      : undefined;
    expect(row?.calculated_rebate_hkd).toBeNull();
    expect(row?.failed_terms).toContain("min_spend_unmet:term_dbs_min_spend");
  });

  it("surfaces cumulative min_spend when month_to_date_spend_hkd is absent", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["supermarket"],
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_citi_super")
      : undefined;
    expect(row?.unknown_exclusions).toContain("min_spend:term_citi_min_cum");
  });

  it("flags min_spend_unmet when cumulative spend stays below the threshold", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["supermarket"],
      assumptions: { month_to_date_spend_hkd: 1000 },
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_citi_super")
      : undefined;
    expect(row?.calculated_rebate_hkd).toBeNull();
    expect(row?.failed_terms).toContain("min_spend_unmet:term_citi_min_cum");
  });

  it("clears cumulative min_spend when month_to_date + amount meets the threshold", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["supermarket"],
      assumptions: { month_to_date_spend_hkd: 1500 },
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_citi_super")
      : undefined;
    expect(row?.calculated_rebate_hkd).toBe(48);
    expect(row?.failed_terms).not.toContain("min_spend_unmet:term_citi_min_cum");
    expect(row?.unknown_exclusions).not.toContain("min_spend:term_citi_min_cum");
  });

  it("clears merchant_list when merchant matches a whitelist member", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      merchant: "sushiro",
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_hsbc_dining")
      : undefined;
    expect(row?.unknown_exclusions).not.toContain(
      "merchant_list:term_hsbc_merchant_list",
    );
    if (res.ok) expect(res.merchant_checked).toBe("sushiro");
  });

  it("echoes merchant_checked and keeps merchant_list unknown when no member matches", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      merchant: "random shop",
    });
    expect(res.ok && res.merchant_checked).toBe("random shop");
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_hsbc_dining")
      : undefined;
    // A fuzzy miss is not proof of non-membership — the row stays unknown,
    // never failed, and the number still computes.
    expect(row?.unknown_exclusions).toContain(
      "merchant_list:term_hsbc_merchant_list",
    );
    expect(row?.failed_terms).not.toContain(
      "merchant_not_listed:term_hsbc_merchant_list",
    );
    expect(row?.calculated_rebate_hkd).toBe(64);
  });

  it("surfaces merchant_list when merchant is not supplied", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_hsbc_dining")
      : undefined;
    expect(row?.unknown_exclusions).toContain(
      "merchant_list:term_hsbc_merchant_list",
    );
  });

  it("clears merchant_list when merchant matches a zh member name", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      merchant: "壽司郎",
    });
    const row = res.ok
      ? res.candidates.find((c) => c.rate_id === "rate_hsbc_dining")
      : undefined;
    expect(row?.unknown_exclusions).not.toContain(
      "merchant_list:term_hsbc_merchant_list",
    );
    if (res.ok) expect(res.merchant_checked).toBe("壽司郎");
  });

  it("scores the hero path: alias supplies the tag, merchant clears the whitelist", async () => {
    // BRA-22 — same shape as the site demo call in packages/site/src/data/demo.ts.
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 280,
      alias: "譚仔",
      merchant: "譚仔",
      card_ids: ["card_hsbc_red", "card_aeon"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.merchant_checked).toBe("譚仔");
    const row = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(row?.unknown_exclusions).not.toContain(
      "merchant_list:term_hsbc_merchant_list",
    );
    expect(row?.calculated_rebate_hkd).toBe(22.4);
  });

  it("echoes exclusive_group and priority on competing rate rows", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const high = res.candidates.find((c) => c.rate_id === "rate_dbs_dining_high");
    const base = res.candidates.find((c) => c.rate_id === "rate_dbs_dining_base");
    expect(high?.exclusive_group).toBe("eminent_cat");
    expect(high?.priority).toBe(1);
    expect(base?.exclusive_group).toBe("eminent_cat");
    expect(base?.priority).toBe(2);
  });

  it("returns the new term fields from get_term", async () => {
    const min = await getTerm(tenv.DB, "term_dbs_min_spend");
    expect(min.ok && min.term.threshold_hkd).toBe(300);
    expect(min.ok && min.term.period).toBe("per_transaction");

    const quota = await getTerm(tenv.DB, "term_dbs_quota");
    expect(quota.ok && quota.term.quota_n).toBe(10000);

    const reg = await getTerm(tenv.DB, "term_hsbc_register");
    expect(reg.ok && reg.term.register_by).toBe("2026-10-31");
  });
});

// ADR 0005: illustrative is per-record — a rate or term is verified when
// source_url is a real URL (not the example.invalid placeholder) and
// last_verified_at is set. The envelope summarizes the returned rows.
describe("per-record provenance — ADR 0005", () => {
  async function insertVerifiedDiningRate() {
    await tenv.DB.prepare(
      "INSERT INTO cards (id, name, issuer, network) " +
        "VALUES ('card_bea', 'BEA Visa Signature', 'BEA', 'visa')",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rates (id, card_id, kind, value, unit, source_url, " +
        "last_verified_at, effective_from, effective_to, exclusive_group, priority) " +
        "VALUES ('rate_bea_dining', 'card_bea', 'rebate_percent', 3.6, 'percent', " +
        "'https://www.hkbea.com.example-check/terms', '2026-10-30', NULL, NULL, NULL, NULL)",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rate_tags (rate_id, tag_id) VALUES ('rate_bea_dining', 'dining')",
    ).run();
  }

  it("marks fixture rows illustrative and echoes source fields on each rate row", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining", limit: 100 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provenance).toMatchObject({
      kind: "synthetic-seed",
      illustrative: true,
    });
    for (const row of res.records) {
      expect(row.illustrative).toBe(true);
      expect(row.source_url).toContain("example.invalid");
      expect(row.last_verified_at).toBe("2026-10-01");
    }
  });

  it("reads cited-seed when every returned record is verified", async () => {
    await insertVerifiedDiningRate();
    const res = await lookupRates(tenv.DB, { card_ids: ["card_bea"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provenance).toMatchObject({
      kind: "cited-seed",
      illustrative: false,
    });
    expect(res.records).toHaveLength(1);
    expect(res.records[0].illustrative).toBe(false);
    expect(res.records[0].source_url).toBe(
      "https://www.hkbea.com.example-check/terms",
    );
    expect(res.records[0].last_verified_at).toBe("2026-10-30");
  });

  it("reads mixed-seed when the page mixes verified and illustrative rows", async () => {
    await insertVerifiedDiningRate();
    const res = await lookupRates(tenv.DB, { tag_id: "dining", limit: 100 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.provenance).toMatchObject({ kind: "mixed-seed", illustrative: true });
    const verified = res.records.find((r) => r.rate_id === "rate_bea_dining");
    const invented = res.records.find((r) => r.rate_id === "rate_hsbc_dining");
    expect(verified?.illustrative).toBe(false);
    expect(invented?.illustrative).toBe(true);
  });

  it("flags get_term and score_candidates rows per record", async () => {
    const invented = await getTerm(tenv.DB, "term_dbs_quota");
    expect(invented.ok && invented.term.illustrative).toBe(true);
    expect(invented.ok && invented.provenance.kind).toBe("synthetic-seed");

    await tenv.DB.prepare(
      "INSERT INTO terms (id, card_id, kind, text, source_url, last_verified_at) " +
        "VALUES ('term_bea_check', 'card_citi_cash', 'eligibility', 'Verified term.', " +
        "'https://www.hkbea.com.example-check/terms', '2026-10-30')",
    ).run();
    const verified = await getTerm(tenv.DB, "term_bea_check");
    expect(verified.ok && verified.term.illustrative).toBe(false);
    expect(verified.ok && verified.provenance.kind).toBe("cited-seed");

    await insertVerifiedDiningRate();
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_bea_dining");
    expect(row?.illustrative).toBe(false);
    expect(row?.source_url).toBe("https://www.hkbea.com.example-check/terms");
    expect(row?.last_verified_at).toBe("2026-10-30");
    expect(res.provenance).toMatchObject({ kind: "mixed-seed" });
  });

  it("marks a record missing either evidence column as illustrative", async () => {
    await tenv.DB.prepare(
      "INSERT INTO rates (id, card_id, kind, value, unit, source_url, " +
        "last_verified_at, effective_from, effective_to, exclusive_group, priority) " +
        "VALUES ('rate_unverified', 'card_citi_cash', 'rebate_percent', 2, 'percent', " +
        "'https://www.citibank.com.hk/real-terms', NULL, NULL, NULL, NULL, NULL)",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rate_tags (rate_id, tag_id) VALUES ('rate_unverified', 'dining')",
    ).run();
    const res = await lookupRates(tenv.DB, { tag_id: "dining", limit: 100 });
    if (!res.ok) return;
    const row = res.records.find((r) => r.rate_id === "rate_unverified");
    expect(row?.illustrative).toBe(true);
  });
});

// ADR 0006: amount is either HKD (`amount_hkd`) or foreign (`amount` +
// `currency` + assumptions.hkd_per_foreign_unit). fx_fee settles on the
// caller's currency assertion: explicit HKD clears it; absent or non-HKD
// keeps it in unknown_exclusions for the caller to cost.
describe("score currency — ADR 0006", () => {
  it("converts a non-HKD amount before scoring and echoes the fx inputs", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount: 100,
      currency: "USD",
      tag_ids: ["dining"],
      card_ids: ["card_aeon"],
      assumptions: { hkd_per_foreign_unit: 7.8 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.amount_hkd).toBe(780);
    expect(res.currency).toBe("USD");
    expect(res.fx_rate).toBe(7.8);
    const row = res.candidates.find((c) => c.rate_id === "rate_aeon_dining");
    expect(row?.calculated_rebate_hkd).toBe(23.4);
  });

  it("rejects a non-HKD amount without hkd_per_foreign_unit", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount: 100,
      currency: "USD",
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("missing_fx_rate");
  });

  it("requires exactly one of amount_hkd and amount", async () => {
    const both = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      amount: 100,
      currency: "USD",
      tag_ids: ["dining"],
      assumptions: { hkd_per_foreign_unit: 7.8 },
    });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error).toBe("invalid_amount");

    const neither = await scoreCandidates(tenv.DB, {
      tag_ids: ["dining"],
    } as Parameters<typeof scoreCandidates>[1]);
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.error).toBe("invalid_amount");
  });

  it("rejects a currency that is not three letters", async () => {
    for (const currency of ["US", "USDX", "H1D"]) {
      const res = await scoreCandidates(tenv.DB, {
        amount_hkd: 800,
        currency,
        tag_ids: ["dining"],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("invalid_currency");
    }
  });

  it("normalizes the currency code for the echo and fx_fee logic", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount: 100,
      currency: "usd",
      tag_ids: ["dining"],
      assumptions: { hkd_per_foreign_unit: 7.8 },
    });
    expect(res.ok && res.currency).toBe("USD");
  });

  it("clears fx_fee on an explicit HKD currency but keeps it for non-HKD", async () => {
    const hkd = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      currency: "HKD",
      tag_ids: ["overseas"],
    });
    expect(hkd.ok).toBe(true);
    if (hkd.ok) {
      const citi = hkd.candidates.find((c) => c.rate_id === "rate_citi_overseas");
      expect(citi?.unknown_exclusions).not.toContain(
        "fx_fee:term_citi_fx_fee",
      );
    }

    const usd = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      currency: "USD",
      tag_ids: ["overseas"],
    });
    expect(usd.ok).toBe(true);
    if (usd.ok) {
      const citi = usd.candidates.find((c) => c.rate_id === "rate_citi_overseas");
      expect(citi?.unknown_exclusions).toContain("fx_fee:term_citi_fx_fee");
      expect(usd.currency).toBe("USD");
      expect(usd.fx_rate).toBeNull();
    }
  });

  it("keeps fx_fee unknown when currency is absent, as before", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const citi = res.candidates.find((c) => c.rate_id === "rate_citi_overseas");
    expect(citi?.unknown_exclusions).toContain("fx_fee:term_citi_fx_fee");
    expect(res.currency).toBe("HKD");
    expect(res.fx_rate).toBeNull();
  });
});

// PRD §3.3: effective windows filter the list and score tools; an explicit
// get_card / get_term by id is an audit fetch and returns the record
// regardless of its window.
describe("effective windows — PRD §3.3", () => {
  async function insertExpiredPromoRate() {
    await tenv.DB.prepare(
      "INSERT INTO rates (id, card_id, kind, value, unit, source_url, " +
        "last_verified_at, effective_from, effective_to, exclusive_group, priority) " +
        "VALUES ('rate_expired_promo', 'card_aeon', 'rebate_percent', 10, 'percent', " +
        "'https://example.invalid/aeon-promo', '2026-10-01', " +
        "'2026-01-01', '2026-02-01', NULL, NULL)",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rate_tags (rate_id, tag_id) " +
        "VALUES ('rate_expired_promo', 'dining')",
    ).run();
  }

  it("drops an out-of-window rate from lookup_rates and score_candidates", async () => {
    await insertExpiredPromoRate();

    const lookup = await lookupRates(tenv.DB, { tag_id: "dining", limit: 100 });
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.records.map((r) => r.rate_id)).not.toContain(
        "rate_expired_promo",
      );
    }

    const score = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["dining"],
    });
    expect(score.ok).toBe(true);
    if (score.ok) {
      expect(score.candidates.map((c) => c.rate_id)).not.toContain(
        "rate_expired_promo",
      );
    }
  });

  it("returns the expired rate when as_of lands inside its window", async () => {
    await insertExpiredPromoRate();

    const lookup = await lookupRates(tenv.DB, {
      tag_id: "dining",
      as_of: "2026-01-15",
      limit: 100,
    });
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      expect(lookup.records.map((r) => r.rate_id)).toContain(
        "rate_expired_promo",
      );
    }

    const score = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["dining"],
      as_of: "2026-01-15",
    });
    expect(score.ok).toBe(true);
    if (!score.ok) return;
    const promo = score.candidates.find(
      (c) => c.rate_id === "rate_expired_promo",
    );
    expect(promo?.calculated_rebate_hkd).toBe(100);
  });

  it("returns an out-of-window record through the by-id fetch tools", async () => {
    const term = await getTerm(tenv.DB, "term_citi_expired_cap");
    expect(term.ok).toBe(true);
    if (term.ok) expect(term.term.effective_to).toBe("2026-03-31");

    await insertExpiredPromoRate();
    const card = await getCard(tenv.DB, "card_aeon");
    expect(card.ok).toBe(true);
    if (card.ok) {
      expect(card.rates.map((r) => r.rate_id)).toContain("rate_expired_promo");
    }
  });

  it("exposes the window on every rate row so an expired row does not read as current", async () => {
    await insertExpiredPromoRate();

    // The unfiltered get_card audit path lists the expired promo — the
    // dates are what let the caller see it is expired, not current.
    const card = await getCard(tenv.DB, "card_aeon");
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    const promo = card.rates.find((r) => r.rate_id === "rate_expired_promo");
    expect(promo?.effective_from).toBe("2026-01-01");
    expect(promo?.effective_to).toBe("2026-02-01");
    // An open-ended rate reports null on both ends.
    const standing = card.rates.find((r) => r.rate_id === "rate_aeon_dining");
    expect(standing?.effective_from).toBeNull();
    expect(standing?.effective_to).toBeNull();

    const lookup = await lookupRates(tenv.DB, {
      tag_id: "dining",
      as_of: "2026-01-15",
      limit: 100,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const inWindow = lookup.records.find(
      (r) => r.rate_id === "rate_expired_promo",
    );
    expect(inWindow?.effective_from).toBe("2026-01-01");
    expect(inWindow?.effective_to).toBe("2026-02-01");
  });

  it("echoes the rate window on score_candidates rows", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const row of res.candidates) {
      expect(row).toHaveProperty("effective_from");
      expect(row).toHaveProperty("effective_to");
    }
    const open = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(open?.effective_from).toBeNull();
    expect(open?.effective_to).toBeNull();
  });
});

// PRD §5: a points rate is valued per its unit — points_per_hkd multiplies,
// hkd_per_mile divides. A unit the tool does not know is an honest flag,
// never a guessed number.
describe("points units — PRD §5", () => {
  it("values an hkd_per_mile rate as amount ÷ value × hkd_per_point", async () => {
    await tenv.DB.prepare(
      "INSERT INTO rates (id, card_id, kind, value, unit, source_url, " +
        "last_verified_at, effective_from, effective_to, exclusive_group, priority) " +
        "VALUES ('rate_miles', 'card_aeon', 'points', 15, 'hkd_per_mile', " +
        "'https://example.invalid/miles', '2026-10-01', NULL, NULL, NULL, NULL)",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rate_tags (rate_id, tag_id) VALUES ('rate_miles', 'dining')",
    ).run();

    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1500,
      tag_ids: ["dining"],
      assumptions: { hkd_per_point: 0.1 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_miles");
    // 1500 HKD ÷ 15 per mile = 100 miles × HK$0.10 = 10.
    expect(row?.calculated_rebate_hkd).toBe(10);
    expect(row?.unknown_exclusions).not.toContain("points_value");
  });

  it("flags an unrecognized points unit instead of computing a guess", async () => {
    await tenv.DB.prepare(
      "INSERT INTO rates (id, card_id, kind, value, unit, source_url, " +
        "last_verified_at, effective_from, effective_to, exclusive_group, priority) " +
        "VALUES ('rate_odd_unit', 'card_aeon', 'points', 2, 'miles_per_hkd', " +
        "'https://example.invalid/odd', '2026-10-01', NULL, NULL, NULL, NULL)",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rate_tags (rate_id, tag_id) " +
        "VALUES ('rate_odd_unit', 'dining')",
    ).run();

    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1500,
      tag_ids: ["dining"],
      assumptions: { hkd_per_point: 0.1 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_odd_unit");
    expect(row?.calculated_rebate_hkd).toBeNull();
    expect(row?.unknown_exclusions).toContain("points_unit:miles_per_hkd");
  });
});

// PRD §5: checked_exclusions clears any term by <kind>:<term id> — the
// caller asserting "this does not apply" beats the settle-me flag even for
// kinds the tool can check itself.
describe("checked_exclusions — PRD §5", () => {
  it("clears cap and exclusion terms by <kind>:<term id>", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: {
        checked_exclusions: [
          "cap:term_hsbc_dining_cap",
          "exclusion:term_hsbc_octopus",
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(hsbc?.unknown_exclusions).not.toContain(
      "cap_remaining:term_hsbc_dining_cap",
    );
    expect(hsbc?.unknown_exclusions).not.toContain("octopus_topup");
  });

  it("clears a checkable min_spend the caller settled", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 100,
      tag_ids: ["dining"],
      assumptions: { checked_exclusions: ["min_spend:term_dbs_min_spend"] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_dbs_dining_high");
    // Below the HK$300 per-transaction gate, but the caller settled it.
    expect(row?.failed_terms).not.toContain(
      "min_spend_unmet:term_dbs_min_spend",
    );
    expect(row?.calculated_rebate_hkd).toBe(5);
  });

  it("clears a merchant_list the caller settled without naming a merchant", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: {
        checked_exclusions: ["merchant_list:term_hsbc_merchant_list"],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(row?.unknown_exclusions).not.toContain(
      "merchant_list:term_hsbc_merchant_list",
    );
  });

  it("surfaces an anchored rolling-window min_spend until settled", async () => {
    // term_dbs_welcome gates on issuance + 60 days — spend inputs cannot
    // prove it, so it rides the cumulative path and stays unknown.
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_dbs_dining_base");
    expect(row?.unknown_exclusions).toContain("min_spend:term_dbs_welcome");
  });
});

// ADR 0009: every term a scored rate cites gets a visible status — passed,
// applied, failed, unchecked, caller_settled, outside_window. Nothing a term
// evaluates to may drop silently, and a checked_exclusions key that matched
// nothing is flagged on the envelope.
describe("candidate conditions — ADR 0009", () => {
  function findCondition(
    row: { conditions?: { term_id: string; kind: string; key: string; status: string }[] },
    termId: string,
  ) {
    return row.conditions?.find((c) => c.term_id === termId);
  }

  it("lists every cited term with its settle key and status", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(hsbc?.conditions?.map((c) => c.term_id)).toEqual([
      "term_hsbc_dining_cap",
      "term_hsbc_merchant_list",
      "term_hsbc_octopus",
    ]);
    expect(findCondition(hsbc!, "term_hsbc_dining_cap")).toMatchObject({
      kind: "cap",
      key: "cap:term_hsbc_dining_cap",
      status: "unchecked",
    });
    // Exclusion conditions key on the exclusion_key callers actually pass.
    expect(findCondition(hsbc!, "term_hsbc_octopus")).toMatchObject({
      kind: "exclusion",
      key: "octopus_topup",
      status: "unchecked",
    });
  });

  it("marks verified gates passed", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      merchant: "sushiro",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dbs = res.candidates.find((c) => c.rate_id === "rate_dbs_dining_high");
    expect(findCondition(dbs!, "term_dbs_min_spend")?.status).toBe("passed");
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(findCondition(hsbc!, "term_hsbc_merchant_list")?.status).toBe(
      "passed",
    );
  });

  it("marks fx_fee passed on an explicit HKD currency", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      currency: "HKD",
      tag_ids: ["overseas"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const citi = res.candidates.find((c) => c.rate_id === "rate_citi_overseas");
    expect(findCondition(citi!, "term_citi_fx_fee")?.status).toBe("passed");
  });

  it("marks an applied cap applied, including clamp-to-zero", async () => {
    for (const [mtd, expected] of [
      [250, 50],
      [400, 0],
    ] as const) {
      const res = await scoreCandidates(tenv.DB, {
        amount_hkd: 800,
        tag_ids: ["dining"],
        assumptions: { month_to_date_rebate_hkd: mtd },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
      expect(hsbc?.calculated_rebate_hkd).toBe(expected);
      expect(findCondition(hsbc!, "term_hsbc_dining_cap")?.status).toBe(
        "applied",
      );
    }
  });

  it("marks an unmet min_spend failed", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 100,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dbs = res.candidates.find((c) => c.rate_id === "rate_dbs_dining_high");
    expect(findCondition(dbs!, "term_dbs_min_spend")?.status).toBe("failed");
    expect(dbs?.failed_terms).toContain("min_spend_unmet:term_dbs_min_spend");
  });

  it("marks caller-asserted terms caller_settled by either settle token", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: {
        checked_exclusions: [
          "cap:term_hsbc_dining_cap",
          "exclusion:term_hsbc_octopus",
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(findCondition(hsbc!, "term_hsbc_dining_cap")?.status).toBe(
      "caller_settled",
    );
    expect(findCondition(hsbc!, "term_hsbc_octopus")?.status).toBe(
      "caller_settled",
    );
  });

  it("marks an inactive term outside_window", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 1000,
      tag_ids: ["overseas"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const citi = res.candidates.find((c) => c.rate_id === "rate_citi_overseas");
    expect(findCondition(citi!, "term_citi_expired_cap")?.status).toBe(
      "outside_window",
    );
    expect(citi?.unknown_exclusions).toContain(
      "term_outside_window:term_citi_expired_cap",
    );
  });

  it("flags checked_exclusions keys that matched nothing, omits the field when all consume", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: {
        checked_exclusions: ["octopus_topup", "cap:term_typo"],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(
      (res as { unmatched_checked_exclusions?: string[] })
        .unmatched_checked_exclusions,
    ).toEqual(["cap:term_typo"]);

    const clean = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: { checked_exclusions: ["octopus_topup"] },
    });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean).not.toHaveProperty("unmatched_checked_exclusions");
  });
});

describe("cap clamp — PRD §5", () => {
  it("clamps to zero, never negative, when month-to-date exhausts the cap", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: { month_to_date_rebate_hkd: 400 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    // cap_hkd 300 − 400 already earned → max(0, …) = 0, not −100.
    expect(hsbc?.calculated_rebate_hkd).toBe(0);
  });
});

// PRD §4: the shared envelope rides every payload — a failure is
// { ok: false, error, detail? } plus the same provenance and seed_as_of.
describe("shared envelope — PRD §4", () => {
  it("carries provenance and seed_as_of on failure payloads", async () => {
    const filtered = await lookupRates(tenv.DB, {});
    expect(filtered.ok).toBe(false);
    if (filtered.ok) return;
    expect(filtered.provenance.kind).toBe("synthetic-seed");
    expect(filtered.seed_as_of).toBe("2026-11-01");

    const missing = await getTerm(tenv.DB, "term_nope");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.provenance.kind).toBe("synthetic-seed");
      expect(missing.seed_as_of).toBe("2026-11-01");
    }
  });
});

// Contract gaps against §4–§6 that the earlier describes did not pin.
describe("score plumbing — PRD §4–§6", () => {
  it("rejects a malformed as_of with invalid_date", async () => {
    const lookup = await lookupRates(tenv.DB, {
      tag_id: "dining",
      as_of: "yesterday",
    });
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) expect(lookup.error).toBe("invalid_date");

    const score = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      as_of: "2026/01/01",
    });
    expect(score.ok).toBe(false);
    if (!score.ok) expect(score.error).toBe("invalid_date");
  });

  it("pages scored rows by limit and reports the pre-limit total", async () => {
    const paged = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      limit: 2,
    });
    expect(paged.ok).toBe(true);
    if (!paged.ok) return;
    expect(paged.candidates).toHaveLength(2);
    expect(paged.total).toBe(4);

    const clamped = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      limit: 500,
    });
    expect(clamped.ok && clamped.limit).toBe(100);
    expect(clamped.ok && clamped.clamped).toBe(true);
    if (clamped.ok) expect(clamped.limit_requested).toBe(500);
  });

  it("rejects an alias that resolves only to cards as missing_spend", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      alias: "hsbc red",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("missing_spend");
  });

  it("treats amount with no currency as HKD units", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount: 800,
      tag_ids: ["dining"],
      card_ids: ["card_aeon"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.amount_hkd).toBe(800);
    expect(res.currency).toBe("HKD");
    expect(res.fx_rate).toBeNull();
  });

  it("names no winner — the payload orders rows, the caller ranks", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).not.toHaveProperty("winner");
    expect(res).not.toHaveProperty("best");
    for (const row of res.candidates) {
      expect(row).not.toHaveProperty("rank");
      expect(row).not.toHaveProperty("winner");
    }
  });
});

// PRD §4: alias matching is normalized — trim, lowercase, collapsed
// spaces — then exact, or either-contains when both sides are ≥2 chars.
describe("resolve_alias normalization — PRD §4", () => {
  it("matches after trim, case-fold, and space collapse", async () => {
    const res = await resolveAlias(tenv.DB, { query: "  HSBC   Red  " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.matches.map((m) => m.text)).toContain("hsbc red");
  });

  it("refuses a single-character contains match", async () => {
    const res = await resolveAlias(tenv.DB, { query: "z" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.matches).toEqual([]);
  });
});

describe("report targets — PRD §4", () => {
  it("accepts a term target as well as card and rate", async () => {
    const res = await reportIssue(tenv.DB, {
      term_id: "term_dbs_quota",
      field: "quota_n",
      claimed_value: "15000",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report_id).toMatch(/^rpt_/);
  });
});

// Property-based specs: generated inputs instead of named examples, so
// boundaries (limit clamps, URL schemes, alias containment, intake bounds)
// are asserted as invariants. Literals mirror the private constants in
// query.ts — a changed bound fails these specs loudly.
describe("input invariants", () => {
  it("applyLimit clamps into [1, 100] or fails with invalid_limit", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.double(), fc.constant(undefined)),
        (n) => {
          const r = applyLimit(n);
          if (n === undefined) {
            expect(r).toEqual({
              limit: 5,
              limit_requested: null,
              clamped: false,
            });
          } else if (!Number.isInteger(n) || n < 1) {
            expect(r).toMatchObject({ ok: false, error: "invalid_limit" });
          } else {
            expect(r).toEqual({
              limit: Math.min(n, 100),
              limit_requested: n,
              clamped: n > 100,
            });
          }
        },
      ),
    );
  });

  it("isHttpUrl accepts only parseable http(s) URLs", () => {
    const badScheme = fc
      .constantFrom("javascript", "data", "file", "ftp", "ws", "mailto", "tel")
      .chain((scheme) => fc.string().map((rest) => `${scheme}:${rest}`));
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        expect(isHttpUrl(url)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(badScheme, (s) => {
        expect(isHttpUrl(s)).toBe(false);
      }),
    );
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (!isHttpUrl(s)) return;
        expect(["http:", "https:"]).toContain(new URL(s).protocol);
      }),
    );
  });

  it("resolve_alias returns only matches satisfying the containment rule", async () => {
    const corpus = [
      ...(
        await tenv.DB.prepare("SELECT text FROM aliases").all<{
          text: string;
        }>()
      ).results.map((r) => r.text),
      ...Object.keys(ISSUER_ALIASES),
      ...Object.keys(NETWORK_ALIASES),
    ];
    const queryArb = fc.oneof(
      fc.string(),
      fc.constantFrom(...corpus),
      // Single code point — under the ≥2 threshold, must match nothing.
      fc.constantFrom(...corpus.map((a) => [...a][0])),
      fc.constantFrom(...corpus).chain((a) =>
        fc
          .tuple(fc.nat(a.length), fc.nat(a.length))
          .map(([i, j]) => a.slice(Math.min(i, j), Math.max(i, j))),
      ),
    );
    let hits = 0;
    await fc.assert(
      fc.asyncProperty(queryArb, async (query) => {
        const res = await resolveAlias(tenv.DB, { query, limit: 100 });
        if (!res.ok) return;
        for (const m of res.matches) {
          expect(aliasContain(query, m.text)).toBe(true);
        }
        if (res.matches.length > 0) hits += 1;
        expect(res.matches.length).toBeLessThanOrEqual(res.total);
      }),
      { numRuns: 30 },
    );
    // Coverage floor: corpus-derived queries should hit often enough that
    // the containment assertion above is meaningfully exercised.
    expect(hits).toBeGreaterThanOrEqual(8);
  });

  it("report_issue refuses free text past its bound and admits text at it", async () => {
    const base = { card_id: "card_dbs", field: "name", claimed_value: "x" };
    const overBound = fc.oneof(
      fc.record({
        field: fc.string({ minLength: 101 }),
        claimed_value: fc.constant("x"),
      }),
      fc.record({
        field: fc.constant("name"),
        claimed_value: fc.string({ minLength: 501 }),
      }),
      fc.record({
        field: fc.constant("name"),
        claimed_value: fc.constant("x"),
        note: fc.string({ minLength: 2001 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(overBound, async (extra) => {
        const res = await reportIssue(tenv.DB, { ...base, ...extra });
        expect(res).toMatchObject({ ok: false, error: "invalid_report" });
      }),
      { numRuns: 30 },
    );

    const atBound = fc.record({
      field: fc.string({ minLength: 1, maxLength: 100 }),
      claimed_value: fc.string({ maxLength: 500 }),
      note: fc.string({ maxLength: 2000 }),
    });
    await fc.assert(
      fc.asyncProperty(atBound, async (input) => {
        const res = await reportIssue(tenv.DB, {
          card_id: "card_dbs",
          ...input,
        });
        expect(res.ok).toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});

// Model-vs-SQL specs: recompute the expected page in JS from the live
// tables and require the tool output to equal it. The production path is
// WHERE clauses + JOINs; the model is plain array filtering — agreement
// across generated filters means the two interpretations of the same
// contract cannot silently drift.
describe("read-model invariants", () => {
  it("lookup_rates returns exactly the rows its filters select, window-aware", async () => {
    // The seed has no windowed rates — without these fixtures every row is
    // vacuously in-window and the as_of clause is never exercised.
    const windowFixtures: [string, string | null, string | null][] = [
      ["rate_pbt_past", "2020-01-01", "2020-12-31"],
      ["rate_pbt_current", "2025-01-01", "2027-12-31"],
      ["rate_pbt_future", "2028-01-01", "2028-12-31"],
      ["rate_pbt_open_from", null, "2026-06-30"],
      ["rate_pbt_open_to", "2026-06-01", null],
    ];
    await tenv.DB.batch(
      windowFixtures.map(([id, from, to]) =>
        tenv.DB
          .prepare(
            `INSERT INTO rates (id, card_id, kind, value, unit, ` +
              `effective_from, effective_to) VALUES (?, 'card_dbs', ` +
              `'rebate_percent', 1, 'percent', ?, ?)`,
          )
          .bind(id, from, to),
      ),
    );

    const rates = (
      await tenv.DB
        .prepare(
          "SELECT r.id, r.card_id, r.effective_from, r.effective_to, " +
            "c.issuer FROM rates r JOIN cards c ON c.id = r.card_id",
        )
        .all<{
          id: string;
          card_id: string;
          effective_from: string | null;
          effective_to: string | null;
          issuer: string;
        }>()
    ).results;
    const tagIds = new Set(
      (
        await tenv.DB.prepare("SELECT id FROM tags").all<{ id: string }>()
      ).results.map((r) => r.id),
    );
    const cardIdList = (
      await tenv.DB.prepare("SELECT id FROM cards").all<{ id: string }>()
    ).results.map((r) => r.id);
    const tagsByRate = new Map<string, string[]>();
    for (const row of (
      await tenv.DB
        .prepare("SELECT rate_id, tag_id FROM rate_tags")
        .all<{ rate_id: string; tag_id: string }>()
    ).results) {
      tagsByRate.set(row.rate_id, [
        ...(tagsByRate.get(row.rate_id) ?? []),
        row.tag_id,
      ]);
    }

    // Bias the generators at the edges where interpretation bugs live:
    // dates sitting on or beside real effective windows, issuer queries
    // that are substrings/case-variants of known aliases, and limit values
    // straddling the clamp. mostly() keeps fields present ~2/3 of the time
    // so AND-combinations dominate over single-filter calls.
    const day = (iso: string, delta: number) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    };
    const windowEdges = new Set<string>();
    for (const r of rates) {
      for (const d of [r.effective_from, r.effective_to]) {
        if (!d) continue;
        windowEdges.add(d);
        windowEdges.add(day(d, -1));
        windowEdges.add(day(d, 1));
      }
    }
    const dateArb = fc.oneof(
      fc.constantFrom(...windowEdges),
      fc
        .tuple(
          fc.integer({ min: 2024, max: 2030 }),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 1, max: 28 }),
        )
        .map(
          ([y, m, d]) =>
            `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        ),
    );
    const issuerCorpus = [
      ...Object.keys(ISSUER_ALIASES),
      ...Object.values(ISSUER_ALIASES),
    ];
    const issuerArb = fc.oneof(
      fc.constantFrom(...issuerCorpus),
      fc
        .constantFrom(...Object.keys(ISSUER_ALIASES))
        .chain((k) =>
          fc
            .tuple(fc.nat(k.length), fc.nat(k.length))
            .map(([i, j]) => k.slice(Math.min(i, j), Math.max(i, j))),
        ),
      fc.constantFrom(...issuerCorpus).map((s) => ` ${s.toUpperCase()}  `),
      fc.string({ minLength: 1 }),
    );
    const mostly = <T>(arb: fc.Arbitrary<T>) =>
      fc.oneof(fc.constant(undefined), arb, arb);
    const richArb = fc.record({
      tag_id: mostly(
        fc.oneof(
          fc.constantFrom(...tagIds),
          fc.constantFrom(...tagIds),
          fc.constantFrom("tag_nope", "ghost_tag"),
          fc.string({ minLength: 1 }),
        ),
      ),
      card_ids: mostly(
        fc.array(
          fc.oneof(
            fc.constantFrom(...cardIdList),
            fc.string({ minLength: 1 }),
          ),
          { maxLength: 4 },
        ),
      ),
      issuer: mostly(issuerArb),
      as_of: mostly(fc.oneof(dateArb, fc.string({ minLength: 1 }))),
      limit: mostly(
        fc.oneof(
          fc.constantFrom(-1, 0, 1, 2, 5, 99, 100, 101, 150),
          fc.integer({ min: -5, max: 150 }),
        ),
      ),
    });
    // And-combinations alone rarely produce non-empty pages — this branch
    // generates exactly-one-filter calls with real values so the matched
    // path (sorting, limit slicing, refs) is exercised often too.
    const cleanArb = fc
      .oneof(
        fc.constantFrom(...tagIds).map((tag_id) => ({ tag_id })),
        fc
          .subarray(cardIdList, { minLength: 1 })
          .map((card_ids) => ({ card_ids })),
        fc.constantFrom(...issuerCorpus).map((issuer) => ({ issuer })),
      )
      .chain((base) =>
        fc
          .record({
            as_of: fc.option(dateArb, { nil: undefined }),
            limit: fc.option(fc.integer({ min: 1, max: 120 }), {
              nil: undefined,
            }),
          })
          .map((extra) => ({ ...base, ...extra })),
      );
    const inputArb = fc.oneof(cleanArb, richArb);

    const issuerParamSet = (q: string) =>
      new Set([
        q,
        ...Object.entries(ISSUER_ALIASES)
          .filter(([text]) => aliasContain(q, text))
          .map(([, iss]) => normText(iss)),
      ]);
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byCardThenId = (a: { card_id: string; id: string }, b: { card_id: string; id: string }) =>
      a.card_id === b.card_id ? cmp(a.id, b.id) : cmp(a.card_id, b.card_id);
    const rowMatches = (
      r: (typeof rates)[number],
      tagId: string | undefined,
      cardIds: string[] | null,
      issuerParams: Set<string> | null,
      asOf: string,
    ) =>
      (r.effective_from === null || r.effective_from <= asOf) &&
      (r.effective_to === null || r.effective_to >= asOf) &&
      (!tagId || (tagsByRate.get(r.id) ?? []).includes(tagId)) &&
      (!cardIds || cardIds.includes(r.card_id)) &&
      (!issuerParams || issuerParams.has(r.issuer.toLowerCase()));

    type LookupInput = {
      tag_id?: string;
      card_ids?: string[];
      issuer?: string;
      as_of?: string;
      limit?: number;
    };
    type Model =
      | { error: "invalid_limit" | "invalid_date" | "missing_filter" }
      | {
          total: number;
          ids: string[];
          unknownTag: boolean;
          pageLimit: number;
        };

    type Norm =
      | { error: "invalid_limit" | "invalid_date" | "missing_filter" }
      | { issuerQuery: string | null; cardIds: string[] | null };

    // Validation order is part of the contract: limit, then date,
    // then the missing-filter guard.
    const normalize = (input: LookupInput): Norm => {
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 1)
      ) {
        return { error: "invalid_limit" as const };
      }
      if (
        input.as_of !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(input.as_of)
      ) {
        return { error: "invalid_date" as const };
      }
      const issuerQuery =
        input.issuer === undefined ? null : normText(input.issuer);
      const cardIds = input.card_ids?.length ? input.card_ids : null;
      if (!input.tag_id && !cardIds && !issuerQuery) {
        return { error: "missing_filter" as const };
      }
      return { issuerQuery, cardIds };
    };

    const model = (input: LookupInput): Model => {
      const n = normalize(input);
      if ("error" in n) return n;
      const issuerParams = n.issuerQuery ? issuerParamSet(n.issuerQuery) : null;
      const tagKnown = !input.tag_id || tagIds.has(input.tag_id);
      const asOf = input.as_of ?? new Date().toISOString().slice(0, 10);
      const matched = tagKnown
        ? rates.filter((r) =>
            rowMatches(r, input.tag_id, n.cardIds, issuerParams, asOf),
          )
        : [];
      const pageLimit =
        input.limit === undefined ? 5 : Math.min(input.limit, 100);
      const ids = [...matched]
        .sort(byCardThenId)
        .slice(0, pageLimit)
        .map((r) => r.id);
      return {
        total: matched.length,
        ids,
        unknownTag: !tagKnown,
        pageLimit,
      };
    };

    // fc.statistics samples the generator and prints its outcome
    // distribution; the counter pins a floor on it so a change that
    // quietly starves the matched path fails here instead of going
    // silently vacuous.
    fc.statistics(
      inputArb,
      (input: LookupInput) => {
        const m = model(input);
        if ("error" in m) return m.error;
        if (m.unknownTag) return "unknown_tag";
        return m.total === 0 ? "matched_none" : "matched";
      },
      { numRuns: 60 },
    );
    let matched = 0;
    await fc.assert(
      fc.asyncProperty(inputArb, async (input: LookupInput) => {
        const res = await lookupRates(tenv.DB, input);
        const expected = model(input);
        if ("error" in expected) {
          expect(res).toMatchObject({ ok: false, error: expected.error });
          return;
        }
        if (!res.ok) {
          return expect.unreachable("lookup_rates rejected a valid input");
        }
        if (expected.total > 0) matched += 1;
        expect(res.limit).toBe(expected.pageLimit);
        expect(res.limit_requested).toBe(input.limit ?? null);
        expect(res.clamped).toBe((input.limit ?? 0) > 100);
        expect(res.total).toBe(expected.total);
        if (expected.unknownTag) {
          expect(res).toMatchObject({ unknown_tag_id: input.tag_id });
        }
        expect(res.records.map((r) => r.rate_id)).toEqual(expected.ids);
      }),
      { numRuns: 60 },
    );
    expect(matched).toBeGreaterThanOrEqual(10);
  });

  it("list_tags returns the id-ordered prefix capped by limit", async () => {
    const all = (
      await tenv.DB.prepare("SELECT id FROM tags ORDER BY id").all<{
        id: string;
      }>()
    ).results.map((r) => r.id);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -3, max: 130 }),
        async (limit) => {
          const res = await listTags(tenv.DB, { limit });
          if (limit < 1) {
            expect(res).toMatchObject({ ok: false, error: "invalid_limit" });
            return;
          }
          if (!res.ok) return;
          expect(res.records.map((r) => r.id)).toEqual(
            all.slice(0, Math.min(limit, 100)),
          );
          expect(res.total).toBe(all.length);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("get_card returns all rates of the card ordered by id", async () => {
    const cardIds = (
      await tenv.DB.prepare("SELECT id FROM cards").all<{ id: string }>()
    ).results.map((r) => r.id);
    const ratesByCard = new Map<string, string[]>();
    for (const row of (
      await tenv.DB
        .prepare("SELECT card_id, id FROM rates ORDER BY id")
        .all<{ card_id: string; id: string }>()
    ).results) {
      ratesByCard.set(row.card_id, [
        ...(ratesByCard.get(row.card_id) ?? []),
        row.id,
      ]);
    }
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constantFrom(...cardIds), fc.string({ minLength: 1 })),
        async (id) => {
          const res = await getCard(tenv.DB, id);
          if (!cardIds.includes(id)) {
            expect(res).toMatchObject({ ok: false, error: "not_found" });
            return;
          }
          if (!res.ok) return;
          expect(res.rates.map((r) => r.rate_id)).toEqual(
            ratesByCard.get(id) ?? [],
          );
          expect(res.rates.every((r) => r.card_id === id)).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ADR 0011: score math is exact decimal — IEEE-754 doubles cannot express
// 0.1 or a .xx5 midpoint, so rounding and threshold comparisons run on
// BigInt rationals, never on the binary float.
describe("exact decimal scoring — ADR 0011", () => {
  it("rounds calculated_rebate_hkd half-up on a .xx5 midpoint", async () => {
    // 125.5 × 1% = 1.255 — binary stores 1.2549999…, so a naive
    // Math.round(x * 100) / 100 drops a cent.
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 125.5,
      tag_ids: ["dining"],
      card_ids: ["card_dbs"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_dbs_dining_base");
    expect(row?.calculated_rebate_hkd).toBe(1.26);
  });

  it("rounds a converted amount half-up to cents", async () => {
    // 1.55 USD × 0.5 = 0.775 — binary stores 0.7749999…, naive rounding
    // drops it to 0.77.
    const res = await scoreCandidates(tenv.DB, {
      amount: 1.55,
      currency: "USD",
      tag_ids: ["dining"],
      assumptions: { hkd_per_foreign_unit: 0.5 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.amount_hkd).toBe(0.78);
  });

  it("applies the remaining cap without subtraction drift", async () => {
    // 300 − 298.995 is 1.005 in decimal but 1.0049999… in binary — the
    // clamped figure must round to 1.01, not 1.00.
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      card_ids: ["card_hsbc_red"],
      assumptions: { month_to_date_rebate_hkd: 298.995 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hsbc = res.candidates.find((c) => c.rate_id === "rate_hsbc_dining");
    expect(hsbc?.calculated_rebate_hkd).toBe(1.01);
  });

  it("compares a cumulative min_spend exactly at the threshold", async () => {
    // 0.1 + 0.7 < 0.8 in binary (0.7999999999999999): a gate the spend
    // exactly meets must not fail. Fixture threshold is HK$0.80.
    await tenv.DB.prepare(
      "INSERT INTO rates (id, card_id, kind, value, unit, source_url, " +
        "last_verified_at, effective_from, effective_to, exclusive_group, priority) " +
        "VALUES ('rate_edge_min', 'card_aeon', 'rebate_percent', 1, 'percent', " +
        "'https://example.invalid/edge', '2026-10-01', NULL, NULL, NULL, NULL)",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rate_tags (rate_id, tag_id) VALUES ('rate_edge_min', 'dining')",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO terms (id, card_id, kind, text, source_url, last_verified_at, " +
        "effective_from, effective_to, cap_hkd, threshold_hkd, quota_n, " +
        "register_by, post_within_days, anchor, anchor_days, period, exclusion_key) " +
        "VALUES ('term_edge_min', 'card_aeon', 'min_spend', 'Illustrative cumulative HK$0.80 gate.', " +
        "'https://example.invalid/edge', '2026-10-01', NULL, NULL, NULL, 0.8, NULL, " +
        "NULL, NULL, NULL, NULL, 'calendar_month', NULL)",
    ).run();
    await tenv.DB.prepare(
      "INSERT INTO rate_terms (rate_id, term_id) VALUES ('rate_edge_min', 'term_edge_min')",
    ).run();

    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 0.7,
      tag_ids: ["dining"],
      card_ids: ["card_aeon"],
      assumptions: { month_to_date_spend_hkd: 0.1 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = res.candidates.find((c) => c.rate_id === "rate_edge_min");
    expect(row?.failed_terms).not.toContain("min_spend_unmet:term_edge_min");
    expect(row?.calculated_rebate_hkd).toBe(0.01);
  });

  it("rejects non-finite numeric input with invalid_amount or missing_fx_rate", async () => {
    const inf = await scoreCandidates(tenv.DB, {
      amount_hkd: Infinity,
      tag_ids: ["dining"],
    });
    expect(inf.ok).toBe(false);
    if (!inf.ok) expect(inf.error).toBe("invalid_amount");

    const nanPoint = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["overseas"],
      assumptions: { hkd_per_point: Number.NaN },
    });
    expect(nanPoint.ok).toBe(false);
    if (!nanPoint.ok) expect(nanPoint.error).toBe("invalid_amount");

    const infMtd = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      assumptions: { month_to_date_rebate_hkd: Infinity },
    });
    expect(infMtd.ok).toBe(false);
    if (!infMtd.ok) expect(infMtd.error).toBe("invalid_amount");

    const infFx = await scoreCandidates(tenv.DB, {
      amount: 100,
      currency: "USD",
      tag_ids: ["dining"],
      assumptions: { hkd_per_foreign_unit: Infinity },
    });
    expect(infFx.ok).toBe(false);
    if (!infFx.ok) expect(infFx.error).toBe("missing_fx_rate");
  });

  it("agrees with integer-cent math on arbitrary spend amounts", async () => {
    // rate_dbs_dining_base is 1%: expected value is cents × 1% rounded
    // half-up — computable exactly in integers.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10_000_000 }),
        async (cents) => {
          const res = await scoreCandidates(tenv.DB, {
            amount_hkd: cents / 100,
            tag_ids: ["dining"],
            card_ids: ["card_dbs"],
          });
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          const row = res.candidates.find(
            (c) => c.rate_id === "rate_dbs_dining_base",
          );
          const expected = Math.floor((cents + 50) / 100) / 100;
          expect(row?.calculated_rebate_hkd).toBe(expected);
        },
      ),
      { numRuns: 30 },
    );
  });
});
