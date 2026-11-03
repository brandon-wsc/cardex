import { ISSUER_ALIASES, NETWORK_ALIASES } from "./aliases";

// ADR 0005: illustrative is per-record — a rate or term is verified when
// source_url is a real URL (not the example.invalid placeholder host the
// synthetic seed fabricates) and last_verified_at is set. The envelope
// provenance summarizes the fact records each payload returned.
const PLACEHOLDER_HOST = "example.invalid";

export interface Provenance {
  kind: "synthetic-seed" | "mixed-seed" | "cited-seed";
  illustrative: boolean;
  note: string;
}

const PROVENANCE: Provenance = {
  kind: "synthetic-seed",
  illustrative: true,
  note: "Invented numbers for tool shape. Not current issuer terms. Confirm with the issuer.",
};

function isIllustrative(
  sourceUrl: string | null,
  verifiedAt: string | null,
): boolean {
  if (!sourceUrl || !verifiedAt) return true;
  try {
    const host = new URL(sourceUrl).hostname;
    return host === PLACEHOLDER_HOST || host.endsWith(`.${PLACEHOLDER_HOST}`);
  } catch {
    return true;
  }
}

function provenanceFor(records: { illustrative: boolean }[]): Provenance {
  if (records.length === 0 || records.every((r) => r.illustrative)) {
    return PROVENANCE;
  }
  if (records.every((r) => !r.illustrative)) {
    return {
      kind: "cited-seed",
      illustrative: false,
      note: "All returned records carry a real source_url and last_verified_at.",
    };
  }
  return {
    kind: "mixed-seed",
    illustrative: true,
    note: "Some returned records are unverified — see each record's illustrative flag.",
  };
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Public intake writes (report_issue here, propose_change in maintain.ts)
// carry free text into tables the admin portal renders. Evidence URLs must
// be http(s): a javascript: href would execute in the admin origin, so it
// is rejected at write time rather than stored.
export function isHttpUrl(s: string): boolean {
  try {
    const p = new URL(s).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

const INTAKE_MAX = { url: 2048, field: 100, claimed_value: 500, note: 2000 };
const REPORT_DAILY_CAP = 500;

function reportBoundsError(input: {
  field: string;
  claimed_value: string;
  note?: string;
  evidence_url?: string;
}): string | null {
  if (input.field.length > INTAKE_MAX.field) return "field too long";
  if (input.claimed_value.length > INTAKE_MAX.claimed_value)
    return "claimed_value too long";
  if (input.note !== undefined && input.note.length > INTAKE_MAX.note)
    return "note too long";
  if (
    input.evidence_url !== undefined &&
    (input.evidence_url.length > INTAKE_MAX.url ||
      !isHttpUrl(input.evidence_url))
  )
    return "evidence_url must be an http(s) URL of at most 2048 chars";
  return null;
}

export interface Assumptions {
  month_to_date_rebate_hkd?: number;
  month_to_date_spend_hkd?: number;
  hkd_per_point?: number;
  hkd_per_foreign_unit?: number;
  checked_exclusions?: string[];
}

type FailureCode =
  | "not_found"
  | "invalid_limit"
  | "invalid_amount"
  | "invalid_currency"
  | "invalid_date"
  | "invalid_report"
  | "missing_filter"
  | "missing_spend"
  | "unmapped_merchant"
  | "missing_fx_rate";

export interface Failure {
  ok: false;
  provenance: Provenance;
  seed_as_of: string | null;
  error: FailureCode;
  detail?: string;
}

interface LimitApplied {
  limit: number;
  limit_requested: number | null;
  clamped: boolean;
}

interface CardRow {
  id: string;
  name: string;
  issuer: string;
  network: string;
}

interface RateRow {
  id: string;
  card_id: string;
  kind: "rebate_percent" | "points";
  value: number;
  unit: string;
  source_url: string | null;
  last_verified_at: string | null;
  effective_from: string | null;
  effective_to: string | null;
  exclusive_group: string | null;
  priority: number | null;
}

type TermKind =
  | "cap"
  | "exclusion"
  | "fx_fee"
  | "min_spend"
  | "registration_required"
  | "channel"
  | "mcc"
  | "quota"
  | "merchant_list"
  | "geo"
  | "targeted"
  | "eligibility";

interface TermRow {
  id: string;
  card_id: string;
  kind: TermKind;
  text: string;
  source_url: string | null;
  last_verified_at: string | null;
  effective_from: string | null;
  effective_to: string | null;
  cap_hkd: number | null;
  threshold_hkd: number | null;
  quota_n: number | null;
  register_by: string | null;
  post_within_days: number | null;
  anchor: string | null;
  anchor_days: number | null;
  period: string | null;
  exclusion_key: string | null;
}

interface TagRow {
  id: string;
  label: string;
  kind: "channel" | "category";
}

interface AliasRow {
  text: string;
  tag_ids: string[];
  card_ids: string[];
}

interface AliasMatch extends AliasRow {
  issuers: string[];
  networks: string[];
}

function fail(
  error: FailureCode,
  detail?: string,
  seed: string | null = null,
): Failure {
  return detail === undefined
    ? { ok: false, provenance: PROVENANCE, seed_as_of: seed, error }
    : { ok: false, provenance: PROVENANCE, seed_as_of: seed, error, detail };
}

async function seedDate(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'seed_as_of'")
    .first<{ value: string }>();
  return row?.value ?? null;
}

export function applyLimit(
  requested: number | undefined,
  seed: string | null = null,
): LimitApplied | Failure {
  if (requested === undefined) {
    return { limit: DEFAULT_LIMIT, limit_requested: null, clamped: false };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    return fail("invalid_limit", "limit must be a positive integer", seed);
  }
  if (requested > MAX_LIMIT) {
    return { limit: MAX_LIMIT, limit_requested: requested, clamped: true };
  }
  return { limit: requested, limit_requested: requested, clamped: false };
}

function checkAsOf(
  asOf: string | undefined,
  seed: string | null = null,
): string | Failure {
  if (asOf === undefined) return new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(asOf)) {
    return fail("invalid_date", "as_of must be a YYYY-MM-DD date", seed);
  }
  return asOf;
}

// A record is active when its window contains the date; NULL means open-ended.
function windowContains(column: string): string {
  return `(${column}_from IS NULL OR ${column}_from <= ?) AND (${column}_to IS NULL OR ${column}_to >= ?)`;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function aliasHits(query: string, alias: string): boolean {
  const q = normalizeText(query);
  const a = normalizeText(alias);
  if (!q || !a) return false;
  if (q === a) return true;
  if ([...q].length < 2 || [...a].length < 2) return false;
  return q.includes(a) || a.includes(q);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

async function groupRefsByOwner(
  db: D1Database,
  table: "rate_tags" | "rate_terms" | "alias_tags" | "alias_cards" | "term_merchants",
  ownerColumn: string,
  refColumn: string,
  ownerIds: string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (ownerIds.length === 0) return grouped;
  const { results } = await db
    .prepare(
      `SELECT ${ownerColumn} AS owner_id, ${refColumn} AS ref_id FROM ${table} ` +
        `WHERE ${ownerColumn} IN (${placeholders(ownerIds.length)}) ORDER BY ${refColumn}`,
    )
    .bind(...ownerIds)
    .all<{ owner_id: string; ref_id: string }>();
  for (const row of results) {
    const list = grouped.get(row.owner_id) ?? [];
    list.push(row.ref_id);
    grouped.set(row.owner_id, list);
  }
  return grouped;
}

function rateRow(
  rate: RateRow & { card_name: string; issuer: string },
  tagIds: string[],
  termIds: string[],
) {
  return {
    rate_id: rate.id,
    card_id: rate.card_id,
    card_name: rate.card_name,
    issuer: rate.issuer,
    kind: rate.kind,
    value: rate.value,
    unit: rate.unit,
    tag_ids: tagIds,
    term_ids: termIds,
    effective_from: rate.effective_from,
    effective_to: rate.effective_to,
    exclusive_group: rate.exclusive_group,
    priority: rate.priority,
    source_url: rate.source_url,
    last_verified_at: rate.last_verified_at,
    illustrative: isIllustrative(rate.source_url, rate.last_verified_at),
  };
}

async function rateRowsWithRefs(
  db: D1Database,
  rows: (RateRow & { card_name: string; issuer: string })[],
) {
  const ids = rows.map((row) => row.id);
  const [tagIds, termIds] = await Promise.all([
    groupRefsByOwner(db, "rate_tags", "rate_id", "tag_id", ids),
    groupRefsByOwner(db, "rate_terms", "rate_id", "term_id", ids),
  ]);
  return rows.map((row) => rateRow(row, tagIds.get(row.id) ?? [], termIds.get(row.id) ?? []));
}

const RATE_COLS =
  "r.id, r.card_id, r.kind, r.value, r.unit, r.source_url, r.last_verified_at, " +
  "r.effective_from, r.effective_to, r.exclusive_group, r.priority, " +
  "c.name AS card_name, c.issuer";

// Issuer matching is never SQL substring: the caller's words resolve
// through the issuer alias map with the same aliasHits rule as
// resolve_alias (normalized exact, or either-contains when both sides
// are at least 2 chars) plus the normalized input itself, so a canonical
// name works even when it is not a known alias. issuer:"a" hits nothing
// instead of matching every issuer whose name contains the letter.
function resolveIssuers(query: string): { params: string[]; canonical: string[] } {
  const params = new Set<string>([query]);
  const canonical = new Set<string>();
  for (const [text, issuer] of Object.entries(ISSUER_ALIASES)) {
    if (!aliasHits(query, text)) continue;
    params.add(normalizeText(issuer));
    canonical.add(issuer);
  }
  return {
    params: [...params].sort(),
    canonical: [...canonical].sort(),
  };
}

// eslint-disable-next-line complexity -- WHERE/filter composition stays linear: each active filter appends one clause
export async function lookupRates(
  db: D1Database,
  input: {
    tag_id?: string;
    card_ids?: string[];
    issuer?: string;
    as_of?: string;
    limit?: number;
  },
) {
  const seed = await seedDate(db);
  const page = applyLimit(input.limit, seed);
  if ("ok" in page) return page;
  const asOf = checkAsOf(input.as_of, seed);
  if (typeof asOf !== "string") return asOf;

  // A filter-less call must not default to a catalog dump — the caller
  // either mistyped a key (which strict input now rejects upstream) or
  // meant to narrow and sent nothing.
  const issuerQuery = input.issuer === undefined ? null : normalizeText(input.issuer);
  const cardIds = input.card_ids?.length ? input.card_ids : null;
  if (!input.tag_id && !cardIds && !issuerQuery) {
    return fail(
      "missing_filter",
      "pass at least one of tag_id, card_ids, or issuer",
      seed,
    );
  }
  const issuer = issuerQuery ? resolveIssuers(issuerQuery) : null;

  const filters = {
    tag_id: input.tag_id || null,
    card_ids: cardIds,
    issuer: issuer ? input.issuer! : null,
    issuer_canonical: issuer ? issuer.canonical : null,
    as_of: asOf,
  };

  if (input.tag_id) {
    const tag = await db.prepare("SELECT id FROM tags WHERE id = ?").bind(input.tag_id).first();
    if (!tag) {
      return {
        ok: true as const,
        provenance: provenanceFor([]),
        seed_as_of: seed,
        ...page,
        filters,
        total: 0,
        unknown_tag_id: input.tag_id,
        records: [],
      };
    }
  }

  const where: string[] = [windowContains("r.effective")];
  const params: unknown[] = [asOf, asOf];
  if (input.tag_id) {
    where.push(
      "EXISTS (SELECT 1 FROM rate_tags rt WHERE rt.rate_id = r.id AND rt.tag_id = ?)",
    );
    params.push(input.tag_id);
  }
  if (cardIds) {
    where.push(`r.card_id IN (${placeholders(cardIds.length)})`);
    params.push(...cardIds);
  }
  if (issuer) {
    where.push(`lower(c.issuer) IN (${placeholders(issuer.params.length)})`);
    params.push(...issuer.params);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalRow = await db
    .prepare(`SELECT count(*) AS n FROM rates r JOIN cards c ON c.id = r.card_id ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT ${RATE_COLS} FROM rates r JOIN cards c ON c.id = r.card_id ${whereSql} ` +
        `ORDER BY r.card_id, r.id LIMIT ?`,
    )
    .bind(...params, page.limit)
    .all<RateRow & { card_name: string; issuer: string }>();

  const records = await rateRowsWithRefs(db, results);
  return {
    ok: true as const,
    provenance: provenanceFor(records),
    seed_as_of: seed,
    ...page,
    filters,
    total: totalRow?.n ?? 0,
    records,
  };
}

export async function getCard(db: D1Database, id: string) {
  const seed = await seedDate(db);
  const card = await db
    .prepare("SELECT id, name, issuer, network FROM cards WHERE id = ?")
    .bind(id)
    .first<CardRow>();
  if (!card) return fail("not_found", id, seed);

  const { results } = await db
    .prepare(
      `SELECT r.id, r.card_id, r.kind, r.value, r.unit, r.source_url, ` +
        `r.last_verified_at, r.effective_from, r.effective_to, ` +
        `r.exclusive_group, r.priority, ? AS card_name, ? AS issuer ` +
        `FROM rates r WHERE r.card_id = ? ORDER BY r.id`,
    )
    .bind(card.name, card.issuer, id)
    .all<RateRow & { card_name: string; issuer: string }>();

  const rates = await rateRowsWithRefs(db, results);
  return {
    ok: true as const,
    provenance: provenanceFor(rates),
    seed_as_of: seed,
    card,
    rates,
    term_ids: [...new Set(rates.flatMap((rate) => rate.term_ids))],
  };
}

export async function getTerm(db: D1Database, id: string) {
  const seed = await seedDate(db);
  const term = await db.prepare("SELECT * FROM terms WHERE id = ?").bind(id).first<TermRow>();
  if (!term) return fail("not_found", id, seed);
  const illustrative = isIllustrative(term.source_url, term.last_verified_at);
  return {
    ok: true as const,
    provenance: provenanceFor([{ illustrative }]),
    seed_as_of: seed,
    term: { ...term, illustrative },
  };
}

export async function listTags(db: D1Database, input: { limit?: number } = {}) {
  const seed = await seedDate(db);
  const page = applyLimit(input.limit, seed);
  if ("ok" in page) return page;
  const totalRow = await db.prepare("SELECT count(*) AS n FROM tags").first<{ n: number }>();
  const { results } = await db
    .prepare("SELECT id, label, kind FROM tags ORDER BY id LIMIT ?")
    .bind(page.limit)
    .all<TagRow>();
  return {
    ok: true as const,
    provenance: PROVENANCE,
    seed_as_of: seed,
    ...page,
    total: totalRow?.n ?? 0,
    records: results,
  };
}

async function allAliases(db: D1Database): Promise<AliasRow[]> {
  const { results } = await db.prepare("SELECT text FROM aliases ORDER BY text").all<{
    text: string;
  }>();
  const texts = results.map((row) => row.text);
  const [tagIds, cardIds] = await Promise.all([
    groupRefsByOwner(db, "alias_tags", "alias_text", "tag_id", texts),
    groupRefsByOwner(db, "alias_cards", "alias_text", "card_id", texts),
  ]);
  return texts.map((text) => ({
    text,
    tag_ids: tagIds.get(text) ?? [],
    card_ids: cardIds.get(text) ?? [],
  }));
}

// Issuer and network aliases come from the code-side maps in ./aliases, not D1.
function staticAliasHits(query: string): AliasMatch[] {
  const rows = new Map<string, AliasMatch>();
  const merge = (map: Record<string, string>, field: "issuers" | "networks") => {
    for (const [text, value] of Object.entries(map)) {
      if (!aliasHits(query, text)) continue;
      const row = rows.get(text) ?? {
        text,
        tag_ids: [],
        card_ids: [],
        issuers: [],
        networks: [],
      };
      row[field].push(value);
      rows.set(text, row);
    }
  };
  merge(ISSUER_ALIASES, "issuers");
  merge(NETWORK_ALIASES, "networks");
  return [...rows.values()];
}

export async function matchingAliases(db: D1Database, query: string): Promise<AliasRow[]> {
  const aliases = await allAliases(db);
  return aliases.filter((alias) => aliasHits(query, alias.text));
}

export async function resolveAlias(
  db: D1Database,
  input: { query: string; limit?: number },
) {
  const seed = await seedDate(db);
  const page = applyLimit(input.limit, seed);
  if ("ok" in page) return page;
  const hits = new Map<string, AliasMatch>();
  for (const alias of await matchingAliases(db, input.query)) {
    hits.set(alias.text, { ...alias, issuers: [], networks: [] });
  }
  for (const row of staticAliasHits(input.query)) {
    const existing = hits.get(row.text);
    if (existing) {
      existing.issuers.push(...row.issuers);
      existing.networks.push(...row.networks);
    } else {
      hits.set(row.text, row);
    }
  }
  const merged = [...hits.values()];
  return {
    ok: true as const,
    provenance: PROVENANCE,
    seed_as_of: seed,
    query: input.query,
    ...page,
    total: merged.length,
    matches: merged.slice(0, page.limit).map((alias) => ({
      text: alias.text,
      tag_ids: alias.tag_ids,
      card_ids: alias.card_ids,
      issuers: alias.issuers,
      networks: alias.networks,
    })),
  };
}

// eslint-disable-next-line complexity -- scoring pipeline: resolve scope, load terms, evaluate each rate
export async function scoreCandidates(
  db: D1Database,
  input: {
    amount_hkd?: number;
    amount?: number;
    currency?: string;
    tag_ids?: string[];
    card_ids?: string[];
    alias?: string;
    merchant?: string;
    assumptions?: Assumptions;
    as_of?: string;
    limit?: number;
  },
) {
  const seed = await seedDate(db);
  const page = applyLimit(input.limit, seed);
  if ("ok" in page) return page;

  // ADR 0006: the spend is either already HKD (amount_hkd) or foreign
  // (amount in currency units, converted by the caller-declared
  // hkd_per_foreign_unit). Cardex never picks an FX rate itself.
  const hasAmountHkd = input.amount_hkd !== undefined;
  const hasAmount = input.amount !== undefined;
  if (hasAmountHkd === hasAmount) {
    return fail(
      "invalid_amount",
      "supply exactly one of amount_hkd or amount",
      seed,
    );
  }
  const spend = (hasAmountHkd ? input.amount_hkd : input.amount)!;
  if (!(spend > 0)) {
    return fail("invalid_amount", "amount must be positive", seed);
  }

  const currency = (input.currency ?? "HKD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return fail("invalid_currency", "currency must be a three-letter code", seed);
  }
  const assumptions = input.assumptions ?? {};
  const fxRate = assumptions.hkd_per_foreign_unit ?? null;
  let amountHkd = spend;
  if (currency !== "HKD" && hasAmount) {
    if (fxRate === null || !(fxRate > 0)) {
      return fail(
        "missing_fx_rate",
        "non-HKD amount needs assumptions.hkd_per_foreign_unit",
        seed,
      );
    }
    amountHkd = round2(spend * fxRate);
  }

  const asOf = checkAsOf(input.as_of, seed);
  if (typeof asOf !== "string") return asOf;

  // Alias hits contribute spend tags and card scope together — resolving
  // "hsbc red" narrows the scored set just like an explicit card_ids list.
  const spendTags = new Set(input.tag_ids ?? []);
  const cardScope = new Set(input.card_ids ?? []);
  if (input.alias) {
    for (const alias of await matchingAliases(db, input.alias)) {
      for (const tagId of alias.tag_ids) spendTags.add(tagId);
      for (const cardId of alias.card_ids) cardScope.add(cardId);
    }
  }
  if (spendTags.size === 0) {
    // A merchant the alias map does not cover is a clarification, not a
    // guess: echo it and hand back the real tag vocabulary so the caller
    // can ask its user which class the spend belongs to.
    if (input.merchant !== undefined) {
      const { results: tagRows } = await db
        .prepare("SELECT id FROM tags ORDER BY id")
        .all<{ id: string }>();
      return {
        ...fail(
          "unmapped_merchant",
          `merchant ${JSON.stringify(input.merchant)} does not resolve to a spend tag — classify the spend with tag_ids or an alias`,
          seed,
        ),
        merchant: input.merchant,
        valid_tag_ids: tagRows.map((row) => row.id),
      };
    }
    return fail(
      "missing_spend",
      "supply tag_ids or an alias that resolves to a tag",
      seed,
    );
  }
  const tagList = [...spendTags];

  // Same contract as lookup_rates' unknown_tag_id: an unrecognized tag
  // never errors the call — the caller gets the rows its known tags earned
  // plus an explicit list of what did not resolve.
  const { results: knownTagRows } = await db
    .prepare(`SELECT id FROM tags WHERE id IN (${placeholders(tagList.length)})`)
    .bind(...tagList)
    .all<{ id: string }>();
  const knownTags = new Set(knownTagRows.map((row) => row.id));
  const unknownTagIds = tagList.filter((id) => !knownTags.has(id)).sort();

  const where: string[] = [
    `EXISTS (SELECT 1 FROM rate_tags rt WHERE rt.rate_id = r.id ` +
      `AND rt.tag_id IN (${placeholders(tagList.length)}))`,
    windowContains("r.effective"),
  ];
  const params: unknown[] = [...tagList, asOf, asOf];
  if (cardScope.size > 0) {
    where.push(`r.card_id IN (${placeholders(cardScope.size)})`);
    params.push(...cardScope);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalRow = await db
    .prepare(`SELECT count(*) AS n FROM rates r ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT ${RATE_COLS} ` +
        `FROM rates r JOIN cards c ON c.id = r.card_id ${whereSql} ` +
        `ORDER BY r.card_id, r.id LIMIT ?`,
    )
    .bind(...params, page.limit)
    .all<RateRow & { card_name: string; issuer: string }>();

  const rateIds = results.map((row) => row.id);
  const termIdsByRate = await groupRefsByOwner(db, "rate_terms", "rate_id", "term_id", rateIds);
  const allTermIds = [...new Set([...termIdsByRate.values()].flat())];
  const termsById = new Map<string, TermRow>();
  if (allTermIds.length) {
    const { results: termRows } = await db
      .prepare(`SELECT * FROM terms WHERE id IN (${placeholders(allTermIds.length)})`)
      .bind(...allTermIds)
      .all<TermRow>();
    for (const term of termRows) termsById.set(term.id, term);
  }

  // Merchant whitelists are fetched only for terms that need them.
  const merchantTermIds = allTermIds.filter(
    (id) => termsById.get(id)?.kind === "merchant_list",
  );
  const merchantsByTerm = await groupRefsByOwner(
    db,
    "term_merchants",
    "term_id",
    "merchant",
    merchantTermIds,
  );

  const checked = new Set(assumptions.checked_exclusions ?? []);
  // ADR 0009: an asserted key is "consumed" when it settles a term on any
  // scored rate. Keys nobody consumed are flagged on the envelope — a typo
  // or stale id must surface, never settle silently.
  const consumed = new Set<string>();
  const consume = (key: string): boolean => {
    if (!checked.has(key)) return false;
    consumed.add(key);
    return true;
  };

  const inWindow = (row: { effective_from: string | null; effective_to: string | null }) =>
    (!row.effective_from || row.effective_from <= asOf) &&
    (!row.effective_to || row.effective_to >= asOf);

  type ConditionStatus =
    | "passed"
    | "applied"
    | "failed"
    | "unchecked"
    | "caller_settled"
    | "outside_window";

  // eslint-disable-next-line complexity -- per-term-kind evaluation state machine
  const candidates = results.map((rate) => {
    const unknown: string[] = [];
    const failed: string[] = [];
    const conditions: {
      term_id: string;
      kind: string;
      key: string;
      status: ConditionStatus;
    }[] = [];
    let calculated: number | null = null;

    if (rate.kind === "rebate_percent") {
      calculated = round2((amountHkd * rate.value) / 100);
    } else if (assumptions.hkd_per_point === undefined) {
      unknown.push("points_value");
    } else if (rate.unit === "points_per_hkd") {
      calculated = round2(amountHkd * rate.value * assumptions.hkd_per_point);
    } else if (rate.unit === "hkd_per_mile" || rate.unit === "hkd_per_point") {
      calculated = round2((amountHkd / rate.value) * assumptions.hkd_per_point);
    } else {
      unknown.push(`points_unit:${rate.unit}`);
    }

    for (const termId of termIdsByRate.get(rate.id) ?? []) {
      const term = termsById.get(termId);
      if (!term) continue;
      // key is the checked_exclusions token that settles the condition;
      // status mirrors the evaluation into the row's audit trail (ADR 0009).
      const key =
        term.kind === "exclusion" && term.exclusion_key
          ? term.exclusion_key
          : `${term.kind}:${term.id}`;
      const condition = (status: ConditionStatus) =>
        conditions.push({ term_id: term.id, kind: term.kind, key, status });

      if (!inWindow(term)) {
        unknown.push(`term_outside_window:${term.id}`);
        condition("outside_window");
        continue;
      }
      if (term.kind === "cap") {
        if (consume(`cap:${term.id}`)) {
          condition("caller_settled");
          continue;
        }
        if (assumptions.month_to_date_rebate_hkd === undefined) {
          unknown.push(`cap_remaining:${term.id}`);
          condition("unchecked");
          continue;
        }
        if (calculated === null || term.cap_hkd === null) {
          condition("passed");
          continue;
        }
        const remaining = Math.max(0, term.cap_hkd - assumptions.month_to_date_rebate_hkd);
        calculated = round2(Math.min(calculated, remaining));
        condition("applied");
        continue;
      }
      if (term.kind === "exclusion") {
        const settled =
          consume(`exclusion:${term.id}`) ||
          (term.exclusion_key !== null && consume(term.exclusion_key));
        if (settled) {
          condition("caller_settled");
          continue;
        }
        if (term.exclusion_key) unknown.push(term.exclusion_key);
        condition("unchecked");
        continue;
      }
      // min_spend is checkable: per-transaction gates compare with the amount;
      // cumulative gates compare with the caller's month_to_date_spend_hkd.
      if (term.kind === "min_spend") {
        if (consume(`min_spend:${term.id}`)) {
          condition("caller_settled");
          continue;
        }
        if (term.threshold_hkd === null) {
          unknown.push(key);
          condition("unchecked");
          continue;
        }
        if (term.period === "per_transaction") {
          if (amountHkd < term.threshold_hkd) {
            failed.push(`min_spend_unmet:${term.id}`);
            calculated = null;
            condition("failed");
          } else {
            condition("passed");
          }
          continue;
        }
        const mtdSpend = assumptions.month_to_date_spend_hkd;
        if (mtdSpend === undefined) {
          unknown.push(key);
          condition("unchecked");
          continue;
        }
        if (mtdSpend + amountHkd < term.threshold_hkd) {
          failed.push(`min_spend_unmet:${term.id}`);
          calculated = null;
          condition("failed");
        } else {
          condition("passed");
        }
        continue;
      }
      // merchant_list is a named whitelist. A fuzzy match can prove membership
      // but never non-membership: a hit clears the term, a miss keeps it
      // unknown, and the payload echoes merchant_checked.
      if (term.kind === "merchant_list") {
        if (consume(`merchant_list:${term.id}`)) {
          condition("caller_settled");
          continue;
        }
        const merchant = input.merchant;
        if (merchant === undefined) {
          unknown.push(key);
          condition("unchecked");
          continue;
        }
        const members = merchantsByTerm.get(term.id) ?? [];
        if (!members.some((member) => aliasHits(merchant, member))) {
          unknown.push(key);
          condition("unchecked");
          continue;
        }
        condition("passed");
        continue;
      }
      // fx_fee settles on the caller's currency assertion (ADR 0006): an
      // explicit HKD bill cannot trigger the fee, so the term passes.
      // Absent or non-HKD keeps it unknown — terms carry no numeric fee
      // field, so the caller costs it.
      if (term.kind === "fx_fee" && input.currency !== undefined && currency === "HKD") {
        consume(`fx_fee:${term.id}`);
        condition("passed");
        continue;
      }
      // Any other kind (fx_fee, registration_required, channel, mcc, quota,
      // geo, targeted, eligibility, and kinds added later) is a term the
      // caller must settle: it is cleared by listing `<kind>:<term id>` in
      // checked_exclusions.
      if (consume(`${term.kind}:${term.id}`)) {
        condition("caller_settled");
        continue;
      }
      unknown.push(`${term.kind}:${term.id}`);
      condition("unchecked");
    }

    return {
      rate_id: rate.id,
      card_id: rate.card_id,
      card_name: rate.card_name,
      kind: rate.kind,
      value: rate.value,
      unit: rate.unit,
      calculated_rebate_hkd: calculated,
      unknown_exclusions: unknown,
      failed_terms: failed,
      conditions,
      effective_from: rate.effective_from,
      effective_to: rate.effective_to,
      exclusive_group: rate.exclusive_group,
      priority: rate.priority,
      source_url: rate.source_url,
      last_verified_at: rate.last_verified_at,
      illustrative: isIllustrative(rate.source_url, rate.last_verified_at),
      assumptions_used: {
        month_to_date_rebate_hkd: assumptions.month_to_date_rebate_hkd ?? null,
        month_to_date_spend_hkd: assumptions.month_to_date_spend_hkd ?? null,
        hkd_per_point: assumptions.hkd_per_point ?? null,
        hkd_per_foreign_unit: fxRate,
        checked_exclusions: [...checked],
      },
    };
  });

  const unmatchedChecked = [...checked].filter((k) => !consumed.has(k)).sort();
  return {
    ok: true as const,
    provenance: provenanceFor(candidates),
    seed_as_of: seed,
    amount_hkd: amountHkd,
    currency,
    fx_rate: fxRate,
    tag_ids: tagList,
    ...(unknownTagIds.length > 0 ? { unknown_tag_ids: unknownTagIds } : {}),
    ...(unmatchedChecked.length > 0
      ? { unmatched_checked_exclusions: unmatchedChecked }
      : {}),
    as_of: asOf,
    merchant_checked: input.merchant ?? null,
    ...page,
    total: totalRow?.n ?? 0,
    candidates,
  };
}

export async function reportIssue(
  db: D1Database,
  input: {
    card_id?: string;
    rate_id?: string;
    term_id?: string;
    field?: string;
    claimed_value?: string;
    evidence_url?: string;
    note?: string;
  },
) {
  const targets = (
    [
      ["card", input.card_id, "cards"],
      ["rate", input.rate_id, "rates"],
      ["term", input.term_id, "terms"],
    ] as const
  ).filter(([, id]) => id !== undefined);

  const seed = await seedDate(db);
  if (
    targets.length !== 1 ||
    input.field === undefined ||
    input.claimed_value === undefined
  ) {
    return fail(
      "invalid_report",
      "supply exactly one of card_id, rate_id, term_id, plus field and claimed_value",
      seed,
    );
  }
  const [targetKind, targetId, table] = targets[0];

  const bounds = reportBoundsError({
    field: input.field,
    claimed_value: input.claimed_value,
    note: input.note,
    evidence_url: input.evidence_url,
  });
  if (bounds) return fail("invalid_report", bounds, seed);

  // Intake cap: unauthenticated writes to quarantine are rate-limited by
  // volume, not caller. Old rows age out of the window, so triage drains it.
  const recent = await db
    .prepare(`SELECT COUNT(*) AS n FROM reports WHERE reported_at > ?`)
    .bind(new Date(Date.now() - 86_400_000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= REPORT_DAILY_CAP) {
    return fail("invalid_report", "report queue is full — try again later", seed);
  }

  const exists = await db
    .prepare(`SELECT id FROM ${table} WHERE id = ?`)
    .bind(targetId)
    .first();
  if (!exists) return fail("not_found", `${targetKind}:${targetId}`, seed);

  const reportId = `rpt_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO reports (id, target_kind, target_id, field, claimed_value, ` +
        `evidence_url, note, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      reportId,
      targetKind,
      targetId,
      input.field,
      input.claimed_value,
      input.evidence_url ?? null,
      input.note ?? null,
      new Date().toISOString(),
    )
    .run();

  return {
    ok: true as const,
    provenance: PROVENANCE,
    seed_as_of: seed,
    report_id: reportId,
  };
}
