const PROVENANCE = {
  kind: "synthetic-seed" as const,
  illustrative: true as const,
  note: "Invented numbers for tool shape. Not current issuer terms. Confirm with the issuer.",
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export interface Assumptions {
  month_to_date_rebate_hkd?: number;
  hkd_per_point?: number;
  checked_exclusions?: string[];
}

type FailureCode = "not_found" | "invalid_limit" | "missing_spend" | "invalid_amount";

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
  kind: "rebate_percent" | "points_per_hkd";
  value: number;
}

interface TermRow {
  id: string;
  card_id: string;
  kind: "cap" | "exclusion";
  text: string;
  source_url: string | null;
  effective_from: string | null;
  effective_to: string | null;
  cap_hkd: number | null;
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

function fail(error: FailureCode, detail?: string): Failure {
  return detail === undefined
    ? { ok: false, provenance: PROVENANCE, error }
    : { ok: false, provenance: PROVENANCE, error, detail };
}

export function applyLimit(requested: number | undefined): LimitApplied | Failure {
  if (requested === undefined) {
    return { limit: DEFAULT_LIMIT, limit_requested: null, clamped: false };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    return fail("invalid_limit", "limit must be an integer >= 1");
  }
  if (requested > MAX_LIMIT) {
    return { limit: MAX_LIMIT, limit_requested: requested, clamped: true };
  }
  return { limit: requested, limit_requested: requested, clamped: false };
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function aliasHits(query: string, alias: string): boolean {
  const q = norm(query);
  const a = norm(alias);
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

async function refsByOwner(
  db: D1Database,
  table: "rate_tags" | "rate_terms" | "alias_tags" | "alias_cards",
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
    tag_ids: tagIds,
    term_ids: termIds,
  };
}

async function rateRowsWithRefs(
  db: D1Database,
  rows: (RateRow & { card_name: string; issuer: string })[],
) {
  const ids = rows.map((row) => row.id);
  const [tagIds, termIds] = await Promise.all([
    refsByOwner(db, "rate_tags", "rate_id", "tag_id", ids),
    refsByOwner(db, "rate_terms", "rate_id", "term_id", ids),
  ]);
  return rows.map((row) => rateRow(row, tagIds.get(row.id) ?? [], termIds.get(row.id) ?? []));
}

export async function lookupRates(
  db: D1Database,
  input: { tag_id?: string; card_id?: string; issuer?: string; limit?: number },
) {
  const page = applyLimit(input.limit);
  if ("ok" in page) return page;

  if (input.tag_id) {
    const tag = await db.prepare("SELECT id FROM tags WHERE id = ?").bind(input.tag_id).first();
    if (!tag) {
      return {
        ok: true as const,
        provenance: PROVENANCE,
        ...page,
        total: 0,
        unknown_tag_id: input.tag_id,
        records: [],
      };
    }
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (input.tag_id) {
    where.push(
      "EXISTS (SELECT 1 FROM rate_tags rt WHERE rt.rate_id = r.id AND rt.tag_id = ?)",
    );
    params.push(input.tag_id);
  }
  if (input.card_id) {
    where.push("r.card_id = ?");
    params.push(input.card_id);
  }
  if (input.issuer) {
    where.push("instr(lower(c.issuer), ?) > 0");
    params.push(norm(input.issuer));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await db
    .prepare(`SELECT count(*) AS n FROM rates r JOIN cards c ON c.id = r.card_id ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT r.id, r.card_id, r.kind, r.value, c.name AS card_name, c.issuer ` +
        `FROM rates r JOIN cards c ON c.id = r.card_id ${whereSql} ` +
        `ORDER BY r.card_id, r.id LIMIT ?`,
    )
    .bind(...params, page.limit)
    .all<RateRow & { card_name: string; issuer: string }>();

  return {
    ok: true as const,
    provenance: PROVENANCE,
    ...page,
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
      `SELECT r.id, r.card_id, r.kind, r.value, ? AS card_name, ? AS issuer ` +
        `FROM rates r WHERE r.card_id = ? ORDER BY r.id`,
    )
    .bind(card.name, card.issuer, id)
    .all<RateRow & { card_name: string; issuer: string }>();

  const rates = await rateRowsWithRefs(db, results);
  return {
    ok: true as const,
    provenance: PROVENANCE,
    card,
    rates,
    term_ids: [...new Set(rates.flatMap((rate) => rate.term_ids))],
  };
}

export async function getTerm(db: D1Database, id: string) {
  const term = await db.prepare("SELECT * FROM terms WHERE id = ?").bind(id).first<TermRow>();
  if (!term) return fail("not_found", id);
  return { ok: true as const, provenance: PROVENANCE, term };
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
    refsByOwner(db, "alias_tags", "alias_text", "tag_id", texts),
    refsByOwner(db, "alias_cards", "alias_text", "card_id", texts),
  ]);
  return texts.map((text) => ({
    text,
    tag_ids: tagIds.get(text) ?? [],
    card_ids: cardIds.get(text) ?? [],
  }));
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
  const hits = await matchingAliases(db, input.query);
  return {
    ok: true as const,
    provenance: PROVENANCE,
    query: input.query,
    ...page,
    total: hits.length,
    matches: hits.slice(0, page.limit).map((alias) => ({
      text: alias.text,
      tag_ids: alias.tag_ids,
      card_ids: alias.card_ids,
    })),
  };
}

export async function scoreCandidates(
  db: D1Database,
  input: {
    amount_hkd: number;
    tag_ids?: string[];
    alias?: string;
    assumptions?: Assumptions;
    limit?: number;
  },
) {
  const page = applyLimit(input.limit);
  if ("ok" in page) return page;
  if (!(input.amount_hkd > 0)) return fail("invalid_amount", "amount_hkd must be > 0");

  const spendTags = new Set(input.tag_ids ?? []);
  if (input.alias) {
    for (const alias of await matchingAliases(db, input.alias)) {
      for (const tagId of alias.tag_ids) spendTags.add(tagId);
    }
  }
  if (spendTags.size === 0) {
    return fail("missing_spend", "pass tag_ids or an alias that maps to a tag");
  }
  const tagList = [...spendTags];

  const totalRow = await db
    .prepare(
      `SELECT count(DISTINCT r.id) AS n FROM rates r JOIN rate_tags rt ON rt.rate_id = r.id ` +
        `WHERE rt.tag_id IN (${placeholders(tagList.length)})`,
    )
    .bind(...tagList)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(
      `SELECT DISTINCT r.id, r.card_id, r.kind, r.value, c.name AS card_name, c.issuer ` +
        `FROM rates r JOIN cards c ON c.id = r.card_id ` +
        `JOIN rate_tags rt ON rt.rate_id = r.id ` +
        `WHERE rt.tag_id IN (${placeholders(tagList.length)}) ` +
        `ORDER BY r.card_id, r.id LIMIT ?`,
    )
    .bind(...tagList, page.limit)
    .all<RateRow & { card_name: string; issuer: string }>();

  const rateIds = results.map((row) => row.id);
  const termIdsByRate = await refsByOwner(db, "rate_terms", "rate_id", "term_id", rateIds);
  const allTermIds = [...new Set([...termIdsByRate.values()].flat())];
  const termsById = new Map<string, TermRow>();
  if (allTermIds.length) {
    const { results: termRows } = await db
      .prepare(`SELECT * FROM terms WHERE id IN (${placeholders(allTermIds.length)})`)
      .bind(...allTermIds)
      .all<TermRow>();
    for (const term of termRows) termsById.set(term.id, term);
  }

  const assumptions = input.assumptions ?? {};
  const checked = new Set(assumptions.checked_exclusions ?? []);

  const candidates = results.map((rate) => {
    const unknown: string[] = [];
    let calculated: number | null = null;

    if (rate.kind === "rebate_percent") {
      calculated = round2((input.amount_hkd * rate.value) / 100);
    } else if (assumptions.hkd_per_point === undefined) {
      unknown.push("points_value");
    } else {
      calculated = round2(input.amount_hkd * rate.value * assumptions.hkd_per_point);
    }

    for (const termId of termIdsByRate.get(rate.id) ?? []) {
      const term = termsById.get(termId);
      if (!term) continue;
      if (term.kind === "exclusion") {
        if (term.exclusion_key && !checked.has(term.exclusion_key)) {
          unknown.push(term.exclusion_key);
        }
        continue;
      }
      if (assumptions.month_to_date_rebate_hkd === undefined) {
        unknown.push(`cap_remaining:${term.id}`);
        continue;
      }
      if (calculated === null || term.cap_hkd === null) continue;
      const remaining = Math.max(0, term.cap_hkd - assumptions.month_to_date_rebate_hkd);
      calculated = round2(Math.min(calculated, remaining));
    }

    return {
      rate_id: rate.id,
      card_id: rate.card_id,
      card_name: rate.card_name,
      kind: rate.kind,
      value: rate.value,
      calculated_rebate_hkd: calculated,
      unknown_exclusions: unknown,
      assumptions_used: {
        month_to_date_rebate_hkd: assumptions.month_to_date_rebate_hkd ?? null,
        hkd_per_point: assumptions.hkd_per_point ?? null,
        checked_exclusions: [...checked],
      },
    };
  });

  return {
    ok: true as const,
    provenance: PROVENANCE,
    amount_hkd: input.amount_hkd,
    tag_ids: tagList,
    ...page,
    total: totalRow?.n ?? 0,
    candidates,
  };
}
