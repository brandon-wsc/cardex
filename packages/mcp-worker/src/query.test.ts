import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  getCard,
  getTerm,
  listTags,
  lookupRates,
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
    expect(res.total).toBe(2);
  });

  it("ANDs tag, card and issuer filters", async () => {
    const byCard = await lookupRates(tenv.DB, {
      tag_id: "dining",
      card_id: "card_hsbc_red",
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

  it("clamps limit above the cap and echoes limit_requested", async () => {
    const res = await lookupRates(tenv.DB, { limit: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limit).toBe(20);
    expect(res.limit_requested).toBe(50);
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
    expect(res.total).toBe(2);
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
    expect(exact.ok && exact.matches[0].card_ids).toContain("card_hsbc_red");

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

// Held contract deltas (PRD v0.3, P1). it.fails rows are expected red today;
// when the delta lands they start passing and vitest reports the flip — that
// is the signal to unmark them. it.todo rows need schema/functions that do not
// exist yet.
describe("held deltas — PRD v0.3", () => {
  it.fails("returns the requested limit between 21 and 100", async () => {
    const res = await lookupRates(tenv.DB, { limit: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.limit).toBe(50);
    expect(res.clamped).toBe(false);
  });

  it.fails("filters rates by card_ids for the held-set path", async () => {
    const res = await lookupRates(tenv.DB, {
      card_ids: ["card_hsbc_red"],
    } as Parameters<typeof lookupRates>[1]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.records.every((r) => r.card_id === "card_hsbc_red")).toBe(true);
  });

  it.fails("restricts scored rows to confirmed card_ids", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 800,
      tag_ids: ["dining"],
      card_ids: ["card_hsbc_red"],
    } as Parameters<typeof scoreCandidates>[1]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.candidates.map((c) => c.card_id)).toEqual(["card_hsbc_red"]);
  });

  it.fails("echoes unit on each rate row", async () => {
    const res = await lookupRates(tenv.DB, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const row of res.records) {
      expect(typeof (row as { unit?: unknown }).unit).toBe("string");
    }
  });

  it.todo("filters terms outside their effective window by as_of");
  it.todo("surfaces fx_fee terms in unknown_exclusions");
  it.todo("report_issue writes to the quarantined reports table");
  it.todo("report_issue rejects a report missing field or claimed_value");
});
