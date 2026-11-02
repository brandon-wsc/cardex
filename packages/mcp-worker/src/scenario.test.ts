import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { resolveAlias, scoreCandidates } from "./query";

// Golden-scenario regression for the G2 eyewear purchase: HK$4,700 at
// Even Realities, scored once as an in-store buy and once online. The
// fixture is frozen, so the spec pins the exact candidate set, the
// calculated amounts, and each row's unknown_exclusions — a seed edit
// that shifts a real answer fails loudly here instead of drifting.
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

describe("golden scenario — G2 eyewear spend", () => {
  it("resolves the eyewear merchant alias to the category tag", async () => {
    const res = await resolveAlias(tenv.DB, { query: "even realities" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hit = res.matches.find((m) => m.text === "even realities");
    expect(hit?.tag_ids).toEqual(["eyewear"]);

    // Coverage gap must fail loudly: an unknown merchant resolves to an
    // explicit empty list, never a silently dropped filter.
    const miss = await resolveAlias(tenv.DB, { query: "sunglass hut" });
    expect(miss.ok && miss.matches).toEqual([]);
  });

  it("scores the in-store variant at HK$4,700", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 4700,
      alias: "even realities",
      tag_ids: ["in_store"],
      merchant: "Even Realities",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tag_ids.sort()).toEqual(["eyewear", "in_store"]);
    expect(res.merchant_checked).toBe("Even Realities");
    expect(res.candidates.map((c) => c.rate_id)).toEqual([
      "rate_boc_eyewear",
      "rate_citi_instore",
    ]);

    const boc = res.candidates[0];
    expect(boc.calculated_rebate_hkd).toBe(235);
    // The merchant name hit the whitelist, so the term clears silently.
    expect(boc.unknown_exclusions).toEqual([]);
    expect(boc.failed_terms).toEqual([]);

    const citi = res.candidates[1];
    expect(citi.calculated_rebate_hkd).toBe(94);
    expect(citi.unknown_exclusions).toEqual([
      "cap_remaining:term_citi_instore_cap",
    ]);
  });

  it("leaves the whitelist term unknown when merchant is absent or misses", async () => {
    const absent = await scoreCandidates(tenv.DB, {
      amount_hkd: 4700,
      alias: "even realities",
      tag_ids: ["in_store"],
    });
    if (absent.ok) {
      const boc = absent.candidates.find((c) => c.rate_id === "rate_boc_eyewear");
      expect(boc?.unknown_exclusions).toContain(
        "merchant_list:term_boc_eyewear_merchants",
      );
    }
    expect(absent.ok).toBe(true);

    // A miss proves nothing: the term stays unknown either way.
    const miss = await scoreCandidates(tenv.DB, {
      amount_hkd: 4700,
      alias: "even realities",
      tag_ids: ["in_store"],
      merchant: "Sunglass Hut",
    });
    if (miss.ok) {
      const boc = miss.candidates.find((c) => c.rate_id === "rate_boc_eyewear");
      expect(boc?.unknown_exclusions).toContain(
        "merchant_list:term_boc_eyewear_merchants",
      );
    }
    expect(miss.ok && miss.merchant_checked).toBe("Sunglass Hut");
  });

  it("scores the online variant at HK$4,700", async () => {
    const res = await scoreCandidates(tenv.DB, {
      amount_hkd: 4700,
      alias: "even realities",
      tag_ids: ["online"],
      merchant: "Even Realities",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tag_ids.sort()).toEqual(["eyewear", "online"]);
    expect(res.candidates.map((c) => c.rate_id)).toEqual([
      "rate_aeon_online",
      "rate_boc_eyewear",
      "rate_hsbc_online",
    ]);

    const [aeon, boc, hsbc] = res.candidates;
    expect(aeon.calculated_rebate_hkd).toBe(235);
    expect(aeon.unknown_exclusions).toEqual([
      "cap_remaining:term_aeon_online_cap",
    ]);
    expect(boc.calculated_rebate_hkd).toBe(235);
    expect(boc.unknown_exclusions).toEqual([]);
    expect(hsbc.calculated_rebate_hkd).toBe(188);
    expect(hsbc.unknown_exclusions).toEqual([
      "registration_required:term_hsbc_register",
    ]);
  });
});
