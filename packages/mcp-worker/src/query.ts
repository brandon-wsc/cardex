import { ISSUER_ALIASES, NETWORK_ALIASES } from "./aliases";

const PROVENANCE = {
  kind: "synthetic-seed" as const,
  illustrative: true as const,
  note: "Invented numbers for tool shape. Not current issuer terms. Confirm with the issuer.",
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Assumptions {
  month_to_date_rebate_hkd?: number;
  month_to_date_spend_hkd?: number;
  hkd_per_point?: number;
  checked_exclusions?: string[];
}

type FailureCode =
  | "not_found"
  | "invalid_limit"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_report"
  | "missing_filter"
  | "missing_spend";

export interface Failure {
  ok: false;
  provenance: typeof PROVENANCE;
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

function fail(error: FailureCode, detail?: string): Failure {
  return detail === undefined
    ? { ok: false, provenance: PROVENANCE, error }
    : { ok: false, provenance: PROVENANCE, error, detail };
}

async function seedDate(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'seed_as_of'")
    .first<{ value: string }>();
  return row?.value ?? null;
}

export function applyLimit(requested: number | undefined): LimitApplied | Failure {
  if (requested === undefined) {
    return { limit: DEFAULT_LIMIT, limit_requested: null, clamped: false };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    return fail("invalid_limit", "limit must be a positive integer");
  }
  if (requested > MAX_LIMIT) {
    return { limit: MAX_LIMIT, limit_requested: requested, clamped: true };
  }
  return { limit: requested, limit_requested: requested, clamped: false };
}

function checkAsOf(asOf: string | undefined): string | Failure {
  if (asOf === undefined) return new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(asOf)) {
    return fail("invalid_date", "as_of must be a YYYY-MM-DD date");
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
    exclusive_group: rate.exclusive_group,
    priority: rate.priority,
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
  const page = applyLimit(input.limit);
  if ("ok" in page) return page;
  const asOf = checkAsOf(input.as_of);
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
        provenance: PROVENANCE,
        seed_as_of: await seedDate(db),
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

  return {
    ok: true as const,
    provenance: PROVENANCE,
    seed_as_of: await seedDate(db),
    ...page,
    filters,
    total: totalRow?.n ?? 0,
    records: await rateRowsWithRefs(db, results),
  };
}

export async function getCard(db: D1Database, id: string) {
  const card = await db
    .prepare("SELECT id, name, issuer, network FROM cards WHERE id = ?")
    .bind(id)
    .first<CardRow>();
  if (!card) return fail("not_found", id);

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
    provenance: PROVENANCE,
    seed_as_of: await seedDate(db),
    card,
    rates,
    term_ids: [...new Set(rates.flatMap((rate) => rate.term_ids))],
  };
}

export async function getTerm(db: D1Database, id: string) {
  const term = await db.prepare("SELECT * FROM terms WHERE id = ?").bind(id).first<TermRow>();
  if (!term) return fail("not_found", id);
  return { ok: true as const, provenance: PROVENANCE, seed_as_of: await seedDate(db), term };
}

export async function listTags(db: D1Database, input: { limit?: number } = {}) {
  const page = applyLimit(input.limit);
  if ("ok" in page) return page;
  const totalRow = await db.prepare("SELECT count(*) AS n FROM tags").first<{ n: number }>();
  const { results } = await db
    .prepare("SELECT id, label, kind FROM tags ORDER BY id LIMIT ?")
    .bind(page.limit)
    .all<TagRow>();
  return {
    ok: true as const,
    provenance: PROVENANCE,
    seed_as_of: await seedDate(db),
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
  const page = applyLimit(input.limit);
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
    seed_as_of: await seedDate(db),
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
    amount_hkd: number;
    tag_ids?: string[];
    card_ids?: string[];
    alias?: string;
    merchant?: string;
    assumptions?: Assumptions;
    as_of?: string;
    limit?: number;
  },
) {
  const page = applyLimit(input.limit);
  if ("ok" in page) return page;
  if (!(input.amount_hkd > 0)) return fail("invalid_amount", "amount_hkd must be positive");
  const asOf = checkAsOf(input.as_of);
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
    return fail("missing_spend", "supply tag_ids or an alias that resolves to a tag");
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

  const assumptions = input.assumptions ?? {};
  const checked = new Set(assumptions.checked_exclusions ?? []);

  const inWindow = (row: { effective_from: string | null; effective_to: string | null }) =>
    (!row.effective_from || row.effective_from <= asOf) &&
    (!row.effective_to || row.effective_to >= asOf);

  // eslint-disable-next-line complexity -- per-term-kind evaluation state machine
  const candidates = results.map((rate) => {
    const unknown: string[] = [];
    const failed: string[] = [];
    let calculated: number | null = null;

    if (rate.kind === "rebate_percent") {
      calculated = round2((input.amount_hkd * rate.value) / 100);
    } else if (assumptions.hkd_per_point === undefined) {
      unknown.push("points_value");
    } else if (rate.unit === "points_per_hkd") {
      calculated = round2(input.amount_hkd * rate.value * assumptions.hkd_per_point);
    } else if (rate.unit === "hkd_per_mile" || rate.unit === "hkd_per_point") {
      calculated = round2((input.amount_hkd / rate.value) * assumptions.hkd_per_point);
    } else {
      unknown.push(`points_unit:${rate.unit}`);
    }

    for (const termId of termIdsByRate.get(rate.id) ?? []) {
      const term = termsById.get(termId);
      if (!term) continue;
      if (!inWindow(term)) {
        unknown.push(`term_outside_window:${term.id}`);
        continue;
      }
      if (term.kind === "cap") {
        if (assumptions.month_to_date_rebate_hkd === undefined) {
          unknown.push(`cap_remaining:${term.id}`);
          continue;
        }
        if (calculated === null || term.cap_hkd === null) continue;
        const remaining = Math.max(0, term.cap_hkd - assumptions.month_to_date_rebate_hkd);
        calculated = round2(Math.min(calculated, remaining));
        continue;
      }
      if (term.kind === "exclusion") {
        if (term.exclusion_key && !checked.has(term.exclusion_key)) {
          unknown.push(term.exclusion_key);
        }
        continue;
      }
      // min_spend is checkable: per-transaction gates compare with the amount;
      // cumulative gates compare with the caller's month_to_date_spend_hkd.
      if (term.kind === "min_spend") {
        const key = `min_spend:${term.id}`;
        if (checked.has(key)) continue;
        if (term.threshold_hkd === null) {
          unknown.push(key);
          continue;
        }
        if (term.period === "per_transaction") {
          if (input.amount_hkd < term.threshold_hkd) {
            failed.push(`min_spend_unmet:${term.id}`);
            calculated = null;
          }
          continue;
        }
        const mtdSpend = assumptions.month_to_date_spend_hkd;
        if (mtdSpend === undefined) {
          unknown.push(key);
          continue;
        }
        if (mtdSpend + input.amount_hkd < term.threshold_hkd) {
          failed.push(`min_spend_unmet:${term.id}`);
          calculated = null;
        }
        continue;
      }
      // merchant_list is a named whitelist. A fuzzy match can prove membership
      // but never non-membership: a hit clears the term, a miss keeps it
      // unknown, and the payload echoes merchant_checked.
      if (term.kind === "merchant_list") {
        const key = `merchant_list:${term.id}`;
        if (checked.has(key)) continue;
        const merchant = input.merchant;
        if (merchant === undefined) {
          unknown.push(key);
          continue;
        }
        const members = merchantsByTerm.get(term.id) ?? [];
        if (!members.some((member) => aliasHits(merchant, member))) {
          unknown.push(key);
        }
        continue;
      }
      // Any other kind (fx_fee, registration_required, channel, mcc, quota,
      // geo, targeted, eligibility, and kinds added later) is a term the
      // caller must settle: it is cleared by listing `<kind>:<term id>` in
      // checked_exclusions.
      const key = `${term.kind}:${term.id}`;
      if (!checked.has(key)) unknown.push(key);
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
      exclusive_group: rate.exclusive_group,
      priority: rate.priority,
      assumptions_used: {
        month_to_date_rebate_hkd: assumptions.month_to_date_rebate_hkd ?? null,
        month_to_date_spend_hkd: assumptions.month_to_date_spend_hkd ?? null,
        hkd_per_point: assumptions.hkd_per_point ?? null,
        checked_exclusions: [...checked],
      },
    };
  });

  return {
    ok: true as const,
    provenance: PROVENANCE,
    seed_as_of: await seedDate(db),
    amount_hkd: input.amount_hkd,
    tag_ids: tagList,
    ...(unknownTagIds.length > 0 ? { unknown_tag_ids: unknownTagIds } : {}),
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

  if (
    targets.length !== 1 ||
    input.field === undefined ||
    input.claimed_value === undefined
  ) {
    return fail(
      "invalid_report",
      "supply exactly one of card_id, rate_id, term_id, plus field and claimed_value",
    );
  }
  const [targetKind, targetId, table] = targets[0];

  const exists = await db
    .prepare(`SELECT id FROM ${table} WHERE id = ?`)
    .bind(targetId)
    .first();
  if (!exists) return fail("not_found", `${targetKind}:${targetId}`);

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
    seed_as_of: await seedDate(db),
    report_id: reportId,
  };
}
