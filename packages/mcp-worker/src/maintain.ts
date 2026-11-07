// Maintenance surface (ADR 0002). FACT_TABLES is the capability boundary:
// only these tables and columns can ever be written through a proposal, and
// every write happens inside one D1 batch at apply time. Proposals carry
// structured patches — never raw SQL.

import { isHttpUrl } from "./query.js";

export type Scalar = string | number | null;

export interface Patch {
  op: "insert" | "update" | "delete";
  table: string;
  id: string;
  key?: Record<string, Scalar>;
  set?: Record<string, Scalar>;
}

interface TableSpec {
  pk: string[];
  required: string[];
  columns: string[];
}

// The capability boundary is the table list — which tables a proposal may
// touch. Column sets are read live from PRAGMA so a new column on a facts
// table is patchable with zero code change.
const FACT_TABLES = new Set([
  "cards",
  "tags",
  "rates",
  "rate_tags",
  "terms",
  "rate_terms",
  "term_merchants",
  "aliases",
  "alias_tags",
  "alias_cards",
]);

interface PragmaRow {
  name: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function specForTable(
  db: D1Database,
  table: string,
): Promise<TableSpec | null> {
  if (!FACT_TABLES.has(table)) return null;
  const { results } = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<PragmaRow>();
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
}

type Failure = { ok: false; error: string; detail?: string };

const fail = (error: string, detail?: string): Failure => ({
  ok: false,
  error,
  detail,
});

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === "string" || typeof v === "number";
}

function isScalarMap(v: unknown): v is Record<string, Scalar> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every(isScalar)
  );
}

export function parsePatch(raw: unknown): Patch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (
    (p.op !== "insert" && p.op !== "update" && p.op !== "delete") ||
    typeof p.table !== "string" ||
    typeof p.id !== "string"
  ) {
    return null;
  }
  if (p.key !== undefined && !isScalarMap(p.key)) return null;
  if (p.set !== undefined && !isScalarMap(p.set)) return null;
  return p as unknown as Patch;
}

function patchKey(patch: Patch, spec: TableSpec): Record<string, Scalar> | null {
  if (spec.pk.length === 1) {
    const key = patch.key ?? { [spec.pk[0]]: patch.id };
    if (key[spec.pk[0]] !== patch.id) return null;
    return key;
  }
  if (!patch.key) return null;
  for (const col of spec.pk) {
    if (!(col in patch.key)) return null;
  }
  return patch.key;
}

// The row an insert will write: pk columns come from `set`, falling back to
// the patch id on single-pk tables. Returns null when a pk value is absent.
function insertTargetKey(
  patch: Patch,
  spec: TableSpec,
): Record<string, Scalar> | null {
  const key: Record<string, Scalar> = {};
  for (const col of spec.pk) {
    const v = patch.set?.[col] ?? (spec.pk.length === 1 ? patch.id : undefined);
    if (v === undefined || v === null) return null;
    key[col] = v;
  }
  return key;
}

function rowKey(patch: Patch, spec: TableSpec): Record<string, Scalar> | null {
  return patch.op === "insert"
    ? insertTargetKey(patch, spec)
    : patchKey(patch, spec);
}

function validateInsert(
  patch: Patch,
  spec: TableSpec,
  errors: string[],
): void {
  if (!patch.set || Object.keys(patch.set).length === 0) {
    errors.push("insert requires a non-empty set");
  } else {
    const merged = { ...patch.set };
    if (spec.pk.length === 1 && !(spec.pk[0] in merged)) {
      merged[spec.pk[0]] = patch.id;
    }
    for (const col of spec.required) {
      if (!(col in merged)) errors.push(`insert missing required '${col}'`);
    }
    for (const col of Object.keys(patch.set)) {
      if (!spec.columns.includes(col)) {
        errors.push(`'${col}' is not a column of ${patch.table}`);
      }
    }
  }
  if (patch.key && patchKey(patch, spec) === null) {
    errors.push("key does not match id");
  }
}

function validateUpdate(
  patch: Patch,
  spec: TableSpec,
  errors: string[],
): void {
  if (!patch.set || Object.keys(patch.set).length === 0) {
    errors.push("update requires a non-empty set");
  } else {
    for (const col of Object.keys(patch.set)) {
      if (spec.pk.includes(col)) {
        errors.push(`cannot update primary key '${col}'`);
      } else if (!spec.columns.includes(col)) {
        errors.push(`'${col}' is not a column of ${patch.table}`);
      }
    }
  }
  if (patchKey(patch, spec) === null) {
    errors.push(
      spec.pk.length > 1
        ? `update on ${patch.table} must name {${spec.pk.join(", ")}} to find the row`
        : "key does not match id",
    );
  }
}

function validateDelete(
  patch: Patch,
  spec: TableSpec,
  errors: string[],
): void {
  if (patch.set && Object.keys(patch.set).length > 0) {
    errors.push("delete must not carry set");
  }
  if (patchKey(patch, spec) === null) {
    errors.push(
      spec.pk.length > 1
        ? `delete on ${patch.table} must name {${spec.pk.join(", ")}} to find the row`
        : "key does not match id",
    );
  }
}

export async function validatePatch(
  db: D1Database,
  raw: unknown,
): Promise<string[]> {
  const patch = parsePatch(raw);
  if (!patch) return ["malformed patch: need {op, table, id, key?, set?}"];

  const spec = await specForTable(db, patch.table);
  if (!spec) return [`'${patch.table}' is outside the patchable facts whitelist`];

  const errors: string[] = [];
  if (patch.op === "insert") validateInsert(patch, spec, errors);
  if (patch.op === "update") validateUpdate(patch, spec, errors);
  if (patch.op === "delete") validateDelete(patch, spec, errors);
  return errors;
}

interface ProposalInput {
  proposed_by?: string;
  summary?: string;
  evidence_url?: string;
  excerpt?: string;
  patches?: unknown[];
}

const PROPOSAL_MAX = {
  url: 2048,
  summary: 500,
  excerpt: 4000,
  patches: 50,
  pending: 100,
};

function proposalBoundsError(input: ProposalInput): string | null {
  if (!input.summary || !input.evidence_url)
    return "summary and evidence_url are required";
  if (input.summary.length > PROPOSAL_MAX.summary) return "summary too long";
  if (
    input.excerpt !== undefined &&
    input.excerpt.length > PROPOSAL_MAX.excerpt
  )
    return "excerpt too long";
  if (
    input.evidence_url.length > PROPOSAL_MAX.url ||
    !isHttpUrl(input.evidence_url)
  )
    return "evidence_url must be an http(s) URL of at most 2048 chars";
  return null;
}

// Pending-queue cap: a leaked maintainer token can spam proposals, so the
// queue stops growing once the owner has a full inbox. Reviewing drains it.
async function pendingQueueFull(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'`)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= PROPOSAL_MAX.pending;
}

export async function proposeChange(db: D1Database, input: ProposalInput) {
  const bounds = proposalBoundsError(input);
  if (bounds) return fail("invalid_proposal", bounds);
  if (!Array.isArray(input.patches) || input.patches.length === 0) {
    return fail("invalid_proposal", "patches must be a non-empty array");
  }
  if (input.patches.length > PROPOSAL_MAX.patches) {
    return fail(
      "invalid_proposal",
      `patches must be at most ${PROPOSAL_MAX.patches} ops`,
    );
  }
  if (await pendingQueueFull(db)) {
    return fail("invalid_proposal", "pending queue is full — wait for review");
  }
  const allErrors: string[] = [];
  for (const [i, raw] of input.patches.entries()) {
    for (const e of await validatePatch(db, raw)) {
      allErrors.push(`patch[${i}]: ${e}`);
    }
  }
  if (allErrors.length > 0) {
    return fail("invalid_patch", allErrors.join("; "));
  }

  const id = `prop_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO proposals (id, proposed_by, summary, evidence_url, ` +
        `excerpt, patches, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      id,
      // Credential-derived, not caller-supplied — one token, one identity,
      // so a proposal can never impersonate another proposer.
      "maintainer",
      input.summary,
      input.evidence_url,
      input.excerpt ?? null,
      JSON.stringify(input.patches),
      new Date().toISOString(),
    )
    .run();

  return { ok: true as const, proposal_id: id };
}

export async function listReports(
  db: D1Database,
  input: {
    limit?: number;
    offset?: number;
    before?: string;
    beforeId?: string;
  },
) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM reports`)
    .first<{ n: number }>();
  const keyset = input.before
    ? input.beforeId
      ? {
          where: `WHERE reported_at < ? OR (reported_at = ? AND id < ?) `,
          binds: [input.before, input.before, input.beforeId],
        }
      : { where: `WHERE reported_at < ? `, binds: [input.before] }
    : { where: ``, binds: [] as string[] };
  const { results } = await db
    .prepare(
      `SELECT id, target_kind, target_id, field, claimed_value, ` +
        `evidence_url, note, reported_at FROM reports ` +
        keyset.where +
        `ORDER BY reported_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...keyset.binds, limit, offset)
    .all();
  return { ok: true as const, total: count?.n ?? 0, reports: results };
}

export async function listProposals(
  db: D1Database,
  input: { status?: string; limit?: number },
) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const rows = input.status
    ? await db
        .prepare(
          `SELECT id, proposed_by, summary, evidence_url, status, ` +
            `created_at, decided_at, decided_by, decision_note, ` +
            `json_array_length(patches) AS patch_count ` +
            `FROM proposals WHERE status = ? ` +
            `ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(input.status, limit)
        .all()
    : await db
        .prepare(
          `SELECT id, proposed_by, summary, evidence_url, status, ` +
            `created_at, decided_at, decided_by, decision_note, ` +
            `json_array_length(patches) AS patch_count ` +
            `FROM proposals ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all();
  return { ok: true as const, proposals: rows.results };
}

// validatePatch whitelists every identifier before apply, but quote anyway
// so a future call path that skips validation fails closed — a bogus `set`
// key becomes one inert quoted identifier instead of injectable SQL.
export function quoteSqlIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function pkWhere(spec: TableSpec): string {
  return spec.pk.map((col) => `${quoteSqlIdent(col)} = ?`).join(" AND ");
}

function pkParams(spec: TableSpec, key: Record<string, Scalar>): Scalar[] {
  return spec.pk.map((col) => key[col]);
}

function fetchRowByKey(
  db: D1Database,
  table: string,
  spec: TableSpec,
  key: Record<string, Scalar>,
) {
  return db
    .prepare(`SELECT * FROM ${table} WHERE ${pkWhere(spec)}`)
    .bind(...pkParams(spec, key))
    .first();
}

// For update/delete `old` is the row being changed; for insert it is the row
// the insert would collide with, so the portal diff shows the conflict.
async function oldRowFor(db: D1Database, patch: Patch) {
  const spec = await specForTable(db, patch.table);
  if (!spec) return null;
  const key = rowKey(patch, spec);
  if (!key) return null;
  return fetchRowByKey(db, patch.table, spec, key);
}

export async function getProposal(db: D1Database, id: string) {
  const row = await db
    .prepare(`SELECT * FROM proposals WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return fail("not_found", `proposal:${id}`);

  type PatchView = (Patch | { op: string; table: string; id: string }) & {
    old: unknown;
    raw?: unknown;
  };
  const rawPatches = JSON.parse(String(row.patches)) as unknown[];
  const patches: PatchView[] = await Promise.all(
    rawPatches.map(async (raw) => {
      const patch = parsePatch(raw);
      if (!patch) {
        return { op: "malformed", table: "", id: "", raw, old: null };
      }
      return { ...patch, old: await oldRowFor(db, patch) };
    }),
  );

  return {
    ok: true as const,
    proposal: { ...row, patches },
  };
}

export function patchStatements(
  patch: Patch,
  spec: TableSpec,
): { sql: string; params: Scalar[] }[] {

  if (patch.op === "insert") {
    const set = { ...patch.set };
    if (spec.pk.length === 1 && !(spec.pk[0] in set)) {
      set[spec.pk[0]] = patch.id;
    }
    const cols = Object.keys(set).sort();
    return [
      {
        sql:
          `INSERT INTO ${quoteSqlIdent(patch.table)} ` +
          `(${cols.map(quoteSqlIdent).join(", ")}) ` +
          `VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => set[c]),
      },
    ];
  }

  const key = patchKey(patch, spec);
  if (!key) return [];
  const where = pkWhere(spec);
  const keyParams = pkParams(spec, key);

  if (patch.op === "update") {
    const set = patch.set ?? {};
    const cols = Object.keys(set).sort();
    return [
      {
        sql:
          `UPDATE ${quoteSqlIdent(patch.table)} SET ` +
          `${cols.map((c) => `${quoteSqlIdent(c)} = ?`).join(", ")} ` +
          `WHERE ${where}`,
        params: [...cols.map((c) => set[c]), ...keyParams],
      },
    ];
  }

  return [
    {
      sql: `DELETE FROM ${quoteSqlIdent(patch.table)} WHERE ${where}`,
      params: keyParams,
    },
  ];
}

// eslint-disable-next-line complexity -- sequential patch-apply state machine: ordered insert/delete preflight, then one batch
export async function decideProposal(
  db: D1Database,
  id: string,
  input: { decision: "approve" | "reject"; decided_by: string; note?: string },
) {
  const row = await db
    .prepare(`SELECT status, patches FROM proposals WHERE id = ?`)
    .bind(id)
    .first<{ status: string; patches: string }>();
  if (!row) return fail("not_found", `proposal:${id}`);
  if (row.status !== "pending") {
    return fail("already_decided", `proposal:${id} is ${row.status}`);
  }

  const now = new Date().toISOString();

  if (input.decision === "reject") {
    if (!input.note) {
      return fail("note_required", "rejecting requires a decision note");
    }
    await db
      .prepare(
        `UPDATE proposals SET status = 'rejected', decided_at = ?, ` +
          `decided_by = ?, decision_note = ? WHERE id = ?`,
      )
      .bind(now, input.decided_by, input.note, id)
      .run();
    return { ok: true as const, status: "rejected" };
  }

  // approve — re-validate, then apply every patch in one batch so a failed
  // statement rolls the whole proposal back. Inserts are pre-flighted in
  // patch order so a collision names the row instead of surfacing a raw
  // SQLITE_CONSTRAINT dump; a delete earlier in the same proposal clears the
  // way (delete-then-insert stays legal).
  const rawPatches = JSON.parse(row.patches) as unknown[];
  const statements: { sql: string; params: Scalar[] }[] = [];
  const inserted = new Set<string>();
  const deleted = new Set<string>();
  for (const [i, raw] of rawPatches.entries()) {
    const errors = await validatePatch(db, raw);
    const patch = parsePatch(raw);
    const spec = patch ? await specForTable(db, patch.table) : null;
    if (errors.length > 0 || !patch || !spec) {
      return fail("invalid_patch", `patch[${i}]: ${errors.join("; ")}`);
    }
    const key = rowKey(patch, spec);
    const token = key
      ? `${patch.table}|${spec.pk.map((c) => String(key[c])).join("|")}`
      : null;
    if (patch.op === "insert" && key && token) {
      if (inserted.has(token)) {
        return fail(
          "invalid_patch",
          `patch[${i}]: ${patch.table} '${patch.id}' is inserted twice in this proposal`,
        );
      }
      if (!deleted.has(token) && (await fetchRowByKey(db, patch.table, spec, key))) {
        return fail(
          "invalid_patch",
          `patch[${i}]: insert into ${patch.table} '${patch.id}' conflicts with an existing row`,
        );
      }
      inserted.add(token);
      deleted.delete(token);
    }
    if (patch.op === "delete" && token) {
      deleted.add(token);
      inserted.delete(token);
    }
    statements.push(...patchStatements(patch, spec));
  }

  const prepared = statements.map(({ sql, params }) => {
    const stmt = db.prepare(sql);
    return params.length ? stmt.bind(...params) : stmt;
  });
  prepared.push(
    db
      .prepare(
        `UPDATE proposals SET status = 'applied', decided_at = ?, ` +
          `decided_by = ?, decision_note = ? WHERE id = ?`,
      )
      .bind(now, input.decided_by, input.note ?? null, id),
  );

  try {
    await db.batch(prepared);
  } catch (e) {
    return fail("apply_failed", e instanceof Error ? e.message : String(e));
  }
  return { ok: true as const, status: "applied" };
}
