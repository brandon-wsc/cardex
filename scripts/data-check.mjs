#!/usr/bin/env node
// Facts-integrity gate — semantic rules over the loaded local D1 (the
// prod snapshot seed/seed.sql after `pnpm migrate && pnpm seed`).
//
// Each check is one SELECT that returns only violation rows (id + detail),
// so a clean snapshot returns zero rows. The rules are derived from the
// PRD and migrations 0001-0005, not restated in DDL — that is why they
// live here as a gate instead of schema constraints.
//
// Exception: the card_fees fee/waiver pairing rules ARE restated in DDL
// (migration 0005 CHECKs). Their audit queries stay for snapshot
// forensics, and they carry `ddlEnforced` — for those, the selftest
// requires the schema itself to reject the planted write. A successful
// insert means the guard regressed, not that the check works:
//
//   1. Orphan FKs on every facts relation the schema declares: rates and
//      terms to cards, both sides of rate_tags / rate_terms /
//      term_merchants / alias_tags / alias_cards.
//   2. unit matches kind — rebate_percent is unit 'percent'; points is
//      one of the units score_candidates interprets in query.ts
//      (points_per_hkd, hkd_per_mile, hkd_per_point).
//   3. rates.value > 0 — a rate is a published figure, never zero or
//      negative.
//   4. Closed effective windows are ordered: when both effective_from and
//      effective_to are set on a rate or term, from <= to.
//   5. exclusive_group pairs with priority (PRD: priority orders rows
//      inside a group only and is NULL for ungrouped rates), and priority
//      is an integer.
//
// Before querying the real DB the script self-tests: for every check it
// rebuilds migrations + seed in an in-memory sqlite, plants the matching
// violation, and requires the check to report the planted row — so a
// silently broken check cannot go green. For `ddlEnforced` checks the
// planted write must fail instead. --selftest-only runs just that
// proof, needing no local D1.
//
// Exit 1 on any violation. Run from the repo root (pnpm data:check).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "packages/mcp-worker/migrations");
const SEED_FILE = join(ROOT, "seed/seed.sql");

const CHECKS = [
  {
    rule: "rates.card_id references cards.id",
    sql: `SELECT r.id AS id, 'card_id ' || r.card_id || ' has no cards row' AS detail
          FROM rates r LEFT JOIN cards c ON c.id = r.card_id WHERE c.id IS NULL`,
    mutate: `INSERT INTO rates (id, card_id, kind, value, unit)
             VALUES ('zz_orphan_rate', 'zz_no_card', 'rebate_percent', 1, 'percent')`,
    planted: "zz_orphan_rate",
  },
  {
    rule: "terms.card_id references cards.id",
    sql: `SELECT t.id AS id, 'card_id ' || t.card_id || ' has no cards row' AS detail
          FROM terms t LEFT JOIN cards c ON c.id = t.card_id WHERE c.id IS NULL`,
    mutate: `INSERT INTO terms (id, card_id, kind, text)
             VALUES ('zz_orphan_term', 'zz_no_card', 'cap', 'x')`,
    planted: "zz_orphan_term",
  },
  {
    rule: "rate_tags.rate_id references rates.id",
    sql: `SELECT rt.rate_id || '/' || rt.tag_id AS id,
          'rate_id ' || rt.rate_id || ' has no rates row' AS detail
          FROM rate_tags rt LEFT JOIN rates r ON r.id = rt.rate_id WHERE r.id IS NULL`,
    mutate: `INSERT INTO rate_tags (rate_id, tag_id) VALUES ('zz_no_rate', 'dining')`,
    planted: "zz_no_rate",
  },
  {
    rule: "rate_tags.tag_id references tags.id",
    sql: `SELECT rt.rate_id || '/' || rt.tag_id AS id,
          'tag_id ' || rt.tag_id || ' has no tags row' AS detail
          FROM rate_tags rt LEFT JOIN tags t ON t.id = rt.tag_id WHERE t.id IS NULL`,
    mutate: `INSERT INTO rate_tags (rate_id, tag_id) VALUES ('rate_hsbc_dining', 'zz_no_tag')`,
    planted: "zz_no_tag",
  },
  {
    rule: "rate_terms.rate_id references rates.id",
    sql: `SELECT rt.rate_id || '/' || rt.term_id AS id,
          'rate_id ' || rt.rate_id || ' has no rates row' AS detail
          FROM rate_terms rt LEFT JOIN rates r ON r.id = rt.rate_id WHERE r.id IS NULL`,
    mutate: `INSERT INTO rate_terms (rate_id, term_id) VALUES ('zz_no_rate', 'term_hsbc_dining_cap')`,
    planted: "zz_no_rate",
  },
  {
    rule: "rate_terms.term_id references terms.id",
    sql: `SELECT rt.rate_id || '/' || rt.term_id AS id,
          'term_id ' || rt.term_id || ' has no terms row' AS detail
          FROM rate_terms rt LEFT JOIN terms t ON t.id = rt.term_id WHERE t.id IS NULL`,
    mutate: `INSERT INTO rate_terms (rate_id, term_id) VALUES ('rate_hsbc_dining', 'zz_no_term')`,
    planted: "zz_no_term",
  },
  {
    rule: "term_merchants.term_id references terms.id",
    sql: `SELECT tm.term_id || '/' || tm.merchant AS id,
          'term_id ' || tm.term_id || ' has no terms row' AS detail
          FROM term_merchants tm LEFT JOIN terms t ON t.id = tm.term_id WHERE t.id IS NULL`,
    mutate: `INSERT INTO term_merchants (term_id, merchant) VALUES ('zz_no_term', 'ZZ Mart')`,
    planted: "zz_no_term",
  },
  {
    rule: "alias_tags.alias_text references aliases.text",
    sql: `SELECT j.alias_text || '/' || j.tag_id AS id,
          'alias_text ' || quote(j.alias_text) || ' has no aliases row' AS detail
          FROM alias_tags j LEFT JOIN aliases a ON a.text = j.alias_text WHERE a.text IS NULL`,
    mutate: `INSERT INTO alias_tags (alias_text, tag_id) VALUES ('zz no alias', 'dining')`,
    planted: "zz no alias",
  },
  {
    rule: "alias_tags.tag_id references tags.id",
    sql: `SELECT j.alias_text || '/' || j.tag_id AS id,
          'tag_id ' || j.tag_id || ' has no tags row' AS detail
          FROM alias_tags j LEFT JOIN tags t ON t.id = j.tag_id WHERE t.id IS NULL`,
    mutate: `INSERT INTO alias_tags (alias_text, tag_id) VALUES ('taobao', 'zz_no_tag')`,
    planted: "zz_no_tag",
  },
  {
    rule: "alias_cards.alias_text references aliases.text",
    sql: `SELECT j.alias_text || '/' || j.card_id AS id,
          'alias_text ' || quote(j.alias_text) || ' has no aliases row' AS detail
          FROM alias_cards j LEFT JOIN aliases a ON a.text = j.alias_text WHERE a.text IS NULL`,
    mutate: `INSERT INTO alias_cards (alias_text, card_id) VALUES ('zz no alias', 'card_mox')`,
    planted: "zz no alias",
  },
  {
    rule: "alias_cards.card_id references cards.id",
    sql: `SELECT j.alias_text || '/' || j.card_id AS id,
          'card_id ' || j.card_id || ' has no cards row' AS detail
          FROM alias_cards j LEFT JOIN cards c ON c.id = j.card_id WHERE c.id IS NULL`,
    mutate: `INSERT INTO alias_cards (alias_text, card_id) VALUES ('mox credit', 'zz_no_card')`,
    planted: "zz_no_card",
  },
  {
    rule: "card_fees.card_id references cards.id",
    sql: `SELECT f.id AS id, 'card_id ' || f.card_id || ' has no cards row' AS detail
          FROM card_fees f LEFT JOIN cards c ON c.id = f.card_id WHERE c.id IS NULL`,
    mutate: `INSERT INTO card_fees (id, card_id, kind, waiver_policy, text)
             VALUES ('zz_orphan_fee', 'zz_no_card', 'annual', 'unknown', 'x')`,
    planted: "zz_orphan_fee",
  },
  {
    rule: "card_fees effective window is ordered",
    sql: `SELECT id, 'effective_from ' || effective_from ||
          ' after effective_to ' || effective_to AS detail
          FROM card_fees WHERE effective_from IS NOT NULL AND effective_to IS NOT NULL
            AND effective_from > effective_to`,
    mutate: `INSERT INTO card_fees (id, card_id, kind, waiver_policy, text,
             effective_from, effective_to)
             VALUES ('zz_bad_window_fee', 'card_hsbc_red', 'annual', 'unknown', 'x',
             '2027-01-01', '2026-01-01')`,
    planted: "zz_bad_window_fee",
  },
  {
    rule: "card_fees.fee_hkd is NULL or non-negative",
    sql: `SELECT id, 'fee_hkd ' || fee_hkd AS detail
          FROM card_fees WHERE fee_hkd < 0`,
    mutate: `INSERT INTO card_fees (id, card_id, kind, fee_hkd, waiver_policy, text)
             VALUES ('zz_neg_fee', 'card_hsbc_red', 'annual', -5, 'unknown', 'x')`,
    planted: "zz_neg_fee",
    ddlEnforced: true,
  },
  {
    rule: "card_fees zero fee pairs with not_applicable",
    sql: `SELECT id, 'fee_hkd 0 with waiver_policy ' || quote(waiver_policy) AS detail
          FROM card_fees WHERE fee_hkd = 0 AND waiver_policy <> 'not_applicable'`,
    mutate: `INSERT INTO card_fees (id, card_id, kind, fee_hkd, waiver_policy, text)
             VALUES ('zz_zero_fee', 'card_hsbc_red', 'annual', 0, 'on_request', 'x')`,
    planted: "zz_zero_fee",
    ddlEnforced: true,
  },
  {
    rule: "card_fees not_applicable pairs with fee_hkd 0",
    sql: `SELECT id, 'not_applicable with fee_hkd ' || coalesce(fee_hkd, 'NULL') AS detail
          FROM card_fees WHERE waiver_policy = 'not_applicable'
            AND (fee_hkd IS NULL OR fee_hkd <> 0)`,
    mutate: `INSERT INTO card_fees (id, card_id, kind, fee_hkd, waiver_policy, text)
             VALUES ('zz_na_fee', 'card_hsbc_red', 'annual', 800, 'not_applicable', 'x')`,
    planted: "zz_na_fee",
    ddlEnforced: true,
  },
  {
    rule: "rebate_percent rates use unit 'percent'",
    sql: `SELECT id, 'kind rebate_percent with unit ' || quote(unit) AS detail
          FROM rates WHERE kind = 'rebate_percent' AND unit <> 'percent'`,
    mutate: `UPDATE rates SET unit = 'zz_bogus' WHERE id = 'rate_hsbc_dining'`,
    planted: "rate_hsbc_dining",
  },
  {
    rule: "points rates use a points unit",
    sql: `SELECT id, 'kind points with unit ' || quote(unit) AS detail
          FROM rates WHERE kind = 'points'
            AND unit NOT IN ('points_per_hkd', 'hkd_per_mile', 'hkd_per_point')`,
    mutate: `UPDATE rates SET unit = 'percent' WHERE id = 'rate_amex_cx_local'`,
    planted: "rate_amex_cx_local",
  },
  {
    rule: "rates.value is positive",
    sql: `SELECT id, 'value ' || value AS detail
          FROM rates WHERE value <= 0`,
    mutate: `UPDATE rates SET value = 0 WHERE id = 'rate_hsbc_dining'`,
    planted: "rate_hsbc_dining",
  },
  {
    rule: "rates effective window is ordered",
    sql: `SELECT id, 'effective_from ' || effective_from ||
          ' after effective_to ' || effective_to AS detail
          FROM rates WHERE effective_from IS NOT NULL AND effective_to IS NOT NULL
            AND effective_from > effective_to`,
    mutate: `UPDATE rates SET effective_from = '2027-01-01', effective_to = '2026-01-01'
             WHERE id = 'rate_citi_overseas'`,
    planted: "rate_citi_overseas",
  },
  {
    rule: "terms effective window is ordered",
    sql: `SELECT id, 'effective_from ' || effective_from ||
          ' after effective_to ' || effective_to AS detail
          FROM terms WHERE effective_from IS NOT NULL AND effective_to IS NOT NULL
            AND effective_from > effective_to`,
    mutate: `UPDATE terms SET effective_from = '2027-01-01', effective_to = '2026-01-01'
             WHERE id = 'term_hsbc_dining_cap'`,
    planted: "term_hsbc_dining_cap",
  },
  {
    rule: "exclusive_group requires priority",
    sql: `SELECT id, 'exclusive_group ' || quote(exclusive_group) ||
          ' with NULL priority' AS detail
          FROM rates WHERE exclusive_group IS NOT NULL AND exclusive_group <> ''
            AND priority IS NULL`,
    mutate: `UPDATE rates SET exclusive_group = 'zz_grp', priority = NULL
             WHERE id = 'rate_amex_blue_base'`,
    planted: "rate_amex_blue_base",
  },
  {
    rule: "priority requires exclusive_group",
    sql: `SELECT id, 'priority ' || priority ||
          ' with NULL or empty exclusive_group' AS detail
          FROM rates WHERE priority IS NOT NULL
            AND (exclusive_group IS NULL OR exclusive_group = '')`,
    mutate: `UPDATE rates SET priority = 9 WHERE id = 'rate_amex_blue_base'`,
    planted: "rate_amex_blue_base",
  },
  {
    rule: "priority is an integer",
    sql: `SELECT id, 'priority ' || quote(priority) || ' is ' || typeof(priority) AS detail
          FROM rates WHERE priority IS NOT NULL AND typeof(priority) <> 'integer'`,
    mutate: `UPDATE rates SET priority = 1.5 WHERE id = 'rate_hsbc_dining'`,
    planted: "rate_hsbc_dining",
  },
];

function buildSeededDb() {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  // The seed inserts junctions before parents and relies on
  // defer_foreign_keys inside one transaction — the same way
  // `wrangler d1 execute --file` loads it.
  db.exec("BEGIN");
  db.exec(readFileSync(SEED_FILE, "utf8"));
  db.exec("COMMIT");
  return db;
}

function selftest() {
  const misses = [];
  for (const check of CHECKS) {
    const db = buildSeededDb();
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(check.mutate);
      if (check.ddlEnforced) {
        misses.push(`${check.rule}: schema accepted planted ${check.planted} — DDL guard missing`);
        continue;
      }
      const rows = db.prepare(check.sql).all();
      if (!rows.some((r) => String(r.id).includes(check.planted))) {
        misses.push(`${check.rule}: planted ${check.planted} not reported`);
      }
    } catch (err) {
      if (!check.ddlEnforced || !/CHECK constraint/i.test(err.message)) {
        misses.push(`${check.rule}: ${err.message}`);
      }
    } finally {
      db.close();
    }
  }
  return misses;
}

function queryLocalD1() {
  const sql = CHECKS.map((c) => c.sql).join(";\n") + ";";
  const raw = execFileSync(
    "pnpm",
    [
      "--dir",
      "packages/mcp-worker",
      "exec",
      "wrangler",
      "d1",
      "execute",
      "cardex-db",
      "--local",
      "--command",
      sql,
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const sets = JSON.parse(raw.slice(raw.indexOf("[")));
  const violations = [];
  for (const [i, check] of CHECKS.entries()) {
    const set = sets[i];
    if (!set || set.success !== true) {
      violations.push({ rule: check.rule, id: "?", detail: "check query failed" });
      continue;
    }
    for (const row of set.results) {
      violations.push({ rule: check.rule, id: row.id, detail: row.detail });
    }
  }
  return violations;
}

const misses = selftest();
if (misses.length > 0) {
  console.error(`data-check selftest FAILED — ${misses.length} check(s) did not catch a planted violation:`);
  for (const m of misses) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`data-check selftest ok — ${CHECKS.length} checks each proved their guard`);

if (process.argv.includes("--selftest-only")) process.exit(0);

let violations;
try {
  violations = queryLocalD1();
} catch (err) {
  console.error("data-check could not query the local D1 — run pnpm migrate && pnpm seed first");
  console.error(String(err.stderr ?? err.message));
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`data-check FAILED — ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  [${v.rule}] ${v.id}: ${v.detail}`);
  process.exit(1);
}
console.log(`data-check ok — ${CHECKS.length} rules, no violations in the loaded facts DB`);
