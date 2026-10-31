// Mock data shaped on the ADR 0002 contracts — proposals carry structured
// patches {op, table, id, set}, never raw SQL. FACTS mirrors current D1 rows
// so the detail view can render old → new.

const FACTS = {
  terms: {
    term_dbs_quota:      { kind: "quota",          quota_n: 10000, text: "First 10,000 registered principal cardholders", last_verified_at: "2026-10-20", source_url: "https://www.dbs.com.hk/personal/cards/credit-cards/dbs-black-world-mastercard" },
    term_hsbc_merchants: { kind: "merchant_list",  text: "8% applies to named merchants only", last_verified_at: "2026-10-12", source_url: "https://www.hsbc.com.hk/credit-cards/products/red/" },
    term_scb_targeted:   { kind: "targeted",       text: "Selected cardholders via SMS or email invite", last_verified_at: "2026-10-05", source_url: "https://www.sc.com/hk/credit-cards/simply-cash/" },
    term_citi_geo:       { kind: "geo",            text: "Overseas = non-HKD settlement, excludes card-present UK/EEA", last_verified_at: "2026-10-08", source_url: "https://www.citibank.com.hk/english/credit-cards/cash-back" },
  },
  rates: {
    rate_citi_overseas:  { card_id: "card_citi_cash", kind: "rebate_percent", value: 3, unit: "percent", effective_to: "2026-11-30" },
    rate_mox_merchant_3: null,
  },
};

const PROPOSALS = [
  {
    id: "prop-0044",
    proposed_by: "grokbot",
    status: "pending",
    created_at: "2026-11-01T09:41:00Z",
    summary: "New Mox merchant cashback promo — 3% at whitelisted merchants, Nov–Dec",
    evidence_url: "https://mox.com/promotions/merchant-cashback-nov",
    excerpt: "Eligible Mox Credit cardholders earn 3% CashBack at Mox CashBack Merchants from 1 Nov to 31 Dec 2026…",
    patches: [
      { op: "insert", table: "rates",      id: "rate_mox_merchant_3",                          set: { card_id: "card_mox", kind: "rebate_percent", value: 3, unit: "percent", effective_from: "2026-11-01", effective_to: "2026-12-31", source_url: "https://mox.com/promotions/merchant-cashback-nov", last_verified_at: "2026-11-01" } },
      { op: "insert", table: "rate_tags",  id: "rate_mox_merchant_3+online",                   set: { rate_id: "rate_mox_merchant_3", tag_id: "online" } },
      { op: "insert", table: "terms",      id: "term_mox_merchant_list",                       set: { card_id: "card_mox", kind: "merchant_list", text: "Mox CashBack Merchants whitelist (see promo page)", source_url: "https://mox.com/promotions/merchant-cashback-nov", last_verified_at: "2026-11-01" } },
      { op: "insert", table: "rate_terms", id: "rate_mox_merchant_3+term_mox_merchant_list",   set: { rate_id: "rate_mox_merchant_3", term_id: "term_mox_merchant_list" } },
    ],
  },
  {
    id: "prop-0043",
    proposed_by: "grokbot",
    status: "pending",
    created_at: "2026-11-01T08:14:00Z",
    summary: "HSBC Red merchant whitelist adds KFC",
    evidence_url: "https://www.hsbc.com.hk/credit-cards/products/red/",
    excerpt: "Eligible merchants: … KFC, Sushiro, TamJai SamGor, Bakehouse …",
    patches: [
      { op: "insert", table: "term_merchants", id: "term_hsbc_merchants+KFC", set: { term_id: "term_hsbc_merchants", merchant: "KFC" } },
      { op: "update", table: "terms",          id: "term_hsbc_merchants",     set: { last_verified_at: "2026-11-01" } },
    ],
  },
  {
    id: "prop-0042",
    proposed_by: "grokbot",
    status: "pending",
    created_at: "2026-10-31T22:03:00Z",
    summary: "DBS Black MC dining promo quota raised 10,000 → 15,000",
    evidence_url: "https://www.dbs.com.hk/personal/cards/credit-cards/dbs-black-world-mastercard",
    excerpt: "The first 15,000 registered Principal Cardholders who spend HK$800 or more on dining…",
    patches: [
      { op: "update", table: "terms", id: "term_dbs_quota", set: { quota_n: 15000, text: "First 15,000 registered principal cardholders", last_verified_at: "2026-11-01" } },
    ],
  },
  {
    id: "prop-0041",
    proposed_by: "grokbot",
    status: "applied",
    created_at: "2026-10-30T11:20:00Z",
    decided_at: "2026-10-30T14:02:00Z",
    decided_by: "brandon@cardex.dev",
    summary: "Citi Cash Back overseas 3% promo extended to 31 Jan",
    evidence_url: "https://www.citibank.com.hk/english/credit-cards/cash-back",
    excerpt: "Promotional period extended to 31 January 2027.",
    patches: [
      { op: "update", table: "rates", id: "rate_citi_overseas", set: { effective_to: "2027-01-31", last_verified_at: "2026-10-30" } },
    ],
  },
  {
    id: "prop-0039",
    proposed_by: "grokbot",
    status: "rejected",
    created_at: "2026-10-29T07:55:00Z",
    decided_at: "2026-10-29T19:30:00Z",
    decided_by: "brandon@cardex.dev",
    decision_note: "Source is an affiliate blog, not the issuer page — cannot verify.",
    summary: "SC Simply Cash overseas allegedly up to 3x points",
    evidence_url: "https://miles-example-blog.hk/sc-simply-cash-deal",
    excerpt: "According to reports, Simply Cash now earns 3x points overseas…",
    patches: [
      { op: "update", table: "rates", id: "rate_scb_overseas", set: { value: 3 } },
    ],
  },
];

const REPORTS = [
  {
    id: "rep-0117",
    target_kind: "rate",
    target_id: "rate_citi_overseas",
    field: "value",
    claimed_value: "2",
    evidence_url: "https://www.citibank.com.hk/english/credit-cards/cash-back",
    note: "3% looks like the old schedule; current page shows 2%.",
    reported_at: "2026-10-31T16:44:00Z",
  },
  {
    id: "rep-0116",
    target_kind: "term",
    target_id: "term_scb_targeted",
    field: "effective_to",
    claimed_value: "2026-10-15",
    evidence_url: "",
    note: "Promo seems finished, page no longer loads.",
    reported_at: "2026-10-30T04:12:00Z",
  },
  {
    id: "rep-0115",
    target_kind: "card",
    target_id: "card_dbs",
    field: "name",
    claimed_value: "DBS Eminent Visa Signature",
    evidence_url: "https://www.dbs.com.hk/personal/cards/credit-cards/eminent",
    note: "",
    reported_at: "2026-10-28T12:01:00Z",
  },
];

function fmtAge(iso) {
  const then = new Date(iso).getTime();
  const now = new Date("2026-11-01T12:00:00Z").getTime();
  const h = Math.max(1, Math.round((now - then) / 3600000));
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

function fmtTs(iso) {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ") + "Z";
}

function lookupFact(table, id) {
  const bucket = FACTS[table];
  return bucket && Object.prototype.hasOwnProperty.call(bucket, id) ? bucket[id] : undefined;
}

Object.assign(window, { FACTS, PROPOSALS, REPORTS, fmtAge, fmtTs, lookupFact });
