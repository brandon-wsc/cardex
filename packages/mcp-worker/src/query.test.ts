import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  getCard,
  getTerm,
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

describe("lookup_rates", () => {
  it("returns matching rates for a tag", async () => {
    const res = await lookupRates(tenv.DB, { tag_id: "dining" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.records.map((r) => r.rate_id);
    expect(ids).toContain("rate_hsbc_dining");
    expect(ids).toContain("rate_aeon_dining");
    expect(res.total).toBe(4);
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
    expect(byIssuer.ok && byIssuer.records).toHaveLength(1);
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
    const res = await lookupRates(tenv.DB, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limit).toBe(5);
    expect(res.limit_requested).toBeNull();
    expect(res.clamped).toBe(false);
  });

  it("clamps limit above 100 and echoes limit_requested", async () => {
    const res = await lookupRates(tenv.DB, { limit: 200 });
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
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.records).toHaveLength(1);
    expect(res.total).toBe(4);
  });
});

describe("get_card", () => {
  it("returns a card with its rates and cited term ids", async () => {
    const res = await getCard(tenv.DB, "card_hsbc_red");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.name).toBe("HSBC Red Credit Card");
    expect(res.rates).toHaveLength(2);
    expect(res.term_ids).toEqual(
      expect.arrayContaining(["term_hsbc_dining_cap", "term_hsbc_octopus"]),
    );
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
    const all = await listTags(tenv.DB);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.total).toBe(4);
    expect(all.records).toHaveLength(4);

    const one = await listTags(tenv.DB, { limit: 1 });
    expect(one.ok && one.records).toHaveLength(1);
    if (one.ok) expect(one.total).toBe(4);
  });
});

describe("resolve_alias", () => {
  it("resolves a merchant alias to its tags", async () => {
    const res = await resolveAlias(tenv.DB, { query: "茶餐廳" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.matches[0].text).toBe("茶餐廳");
    expect(res.matches[0].tag_ids).toContain("dining");
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
    expect(res.matches[0].issuers).toContain("HSBC");
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
    expect(res.matches[0].networks).toContain("unionpay");
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
    const res = await lookupRates(tenv.DB, { limit: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limit).toBe(50);
    expect(res.clamped).toBe(false);
  });

  it("filters rates by card_ids for the held-set path", async () => {
    const res = await lookupRates(tenv.DB, { card_ids: ["card_hsbc_red"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.records.every((r) => r.card_id === "card_hsbc_red")).toBe(true);
    expect(res.total).toBe(2);
  });

  it("restricts scored rows to confirmed card_ids", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      card_ids: ["card_hsbc_red"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.card_id)).toEqual(["card_hsbc_red"]);
  });

  it("echoes unit on each rate row", async () => {
    const res = await lookupRates(tenv.DB, {});
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
    const res = await lookupRates(tenv.DB, {});
    expect(res.ok && res.seed_as_of).toBe("2026-11-01");
  });

  it("narrows the scored set by card hits from an alias", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      alias: "hsbc red",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.card_id)).toEqual(["card_hsbc_red"]);
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

    const row = await tenv.DB
      .prepare("SELECT * FROM reports WHERE id = ?")
      .bind(res.report_id)
      .first<Record<string, unknown>>();
    expect(row?.target_kind).toBe("rate");
    expect(row?.field).toBe("value");
    expect(row?.claimed_value).toBe("6");
    // Quarantine: the report is not part of any query-tool payload.
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
