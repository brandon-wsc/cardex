// Maintenance surface (ADR 0002). FACT_TABLES is the capability boundary:
// only these tables and columns can ever be written through a proposal, and
// every write happens inside one D1 batch at apply time. Proposals carry
// structured patches — never raw SQL.

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

const FACT_TABLES: Record<string, TableSpec> = {
  cards: {
    pk: ["id"],
    required: ["id", "name", "issuer", "network"],
    columns: ["id", "name", "issuer", "network"],
  },
  tags: {
    pk: ["id"],
    required: ["id", "label", "kind"],
    columns: ["id", "label", "kind"],
  },
  rates: {
    pk: ["id"],
    required: ["id", "card_id", "kind", "value", "unit"],
    columns: [
      "id", "card_id", "kind", "value", "unit", "source_url",
      "last_verified_at", "effective_from", "effective_to",
      "exclusive_group", "priority",
    ],
  },
  rate_tags: {
    pk: ["rate_id", "tag_id"],
    required: ["rate_id", "tag_id"],
    columns: ["rate_id", "tag_id"],
  },
  terms: {
    pk: ["id"],
    required: ["id", "card_id", "kind", "text"],
    columns: [
      "id", "card_id", "kind", "text", "source_url", "last_verified_at",
      "effective_from", "effective_to", "cap_hkd", "threshold_hkd",
      "quota_n", "register_by", "post_within_days", "anchor",
      "anchor_days", "period", "exclusion_key",
    ],
  },
  rate_terms: {
    pk: ["rate_id", "term_id"],
    required: ["rate_id", "term_id"],
    columns: ["rate_id", "term_id"],
  },
  term_merchants: {
    pk: ["term_id", "merchant"],
    required: ["term_id", "merchant"],
    columns: ["term_id", "merchant"],
  },
  aliases: {
    pk: ["text"],
    required: ["text"],
    columns: ["text"],
  },
  alias_tags: {
    pk: ["alias_text", "tag_id"],
    required: ["alias_text", "tag_id"],
    columns: ["alias_text", "tag_id"],
  },
  alias_cards: {
    pk: ["alias_text", "card_id"],
    required: ["alias_text", "card_id"],
    columns: ["alias_text", "card_id"],
  },
};

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

export function validatePatch(raw: unknown): string[] {
  const patch = parsePatch(raw);
  if (!patch) return ["malformed patch: need {op, table, id, key?, set?}"];

  const spec = FACT_TABLES[patch.table];
  if (!spec) return [`table '${patch.table}' is not a facts table`];

  const errors: string[] = [];

  if (patch.op === "insert") {
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

  if (patch.op === "update") {
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
          ? `update on ${patch.table} requires key {${spec.pk.join(", ")}}`
          : "key does not match id",
      );
    }
  }

  if (patch.op === "delete") {
    if (patch.set && Object.keys(patch.set).length > 0) {
      errors.push("delete must not carry set");
    }
    if (patchKey(patch, spec) === null) {
      errors.push(
        spec.pk.length > 1
          ? `delete on ${patch.table} requires key {${spec.pk.join(", ")}}`
          : "key does not match id",
      );
    }
  }

  return errors;
}

interface ProposalInput {
  proposed_by?: string;
  summary?: string;
  evidence_url?: string;
  excerpt?: string;
  patches?: unknown[];
}

export async function proposeChange(db: D1Database, input: ProposalInput) {
  if (!input.summary || !input.evidence_url) {
    return fail("invalid_proposal", "summary and evidence_url are required");
  }
  if (!Array.isArray(input.patches) || input.patches.length === 0) {
    return fail("invalid_proposal", "patches must be a non-empty array");
  }
  const allErrors: string[] = [];
  input.patches.forEach((raw, i) => {
    for (const e of validatePatch(raw)) allErrors.push(`patch[${i}]: ${e}`);
  });
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
      input.proposed_by ?? "maintainer",
      input.summary,
      input.evidence_url,
      input.excerpt ?? null,
      JSON.stringify(input.patches),
      new Date().toISOString(),
    )
    .run();

  return { ok: true as const, proposal_id: id };
}

export async function listReports(db: D1Database, input: { limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const { results } = await db
    .prepare(
      `SELECT id, target_kind, target_id, field, claimed_value, ` +
        `evidence_url, note, reported_at FROM reports ` +
        `ORDER BY reported_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return { ok: true as const, reports: results };
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

async function fetchOldRow(db: D1Database, patch: Patch) {
  const spec = FACT_TABLES[patch.table];
  if (!spec || patch.op === "insert") return null;
  const key = patchKey(patch, spec);
  if (!key) return null;
  const where = spec.pk.map((col) => `${col} = ?`).join(" AND ");
  return db
    .prepare(`SELECT * FROM ${patch.table} WHERE ${where}`)
    .bind(...spec.pk.map((col) => key[col]))
    .first();
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
      return { ...patch, old: await fetchOldRow(db, patch) };
    }),
  );

  return {
    ok: true as const,
    proposal: { ...row, patches },
  };
}

function applyStatements(patch: Patch): { sql: string; params: Scalar[] }[] {
  const spec = FACT_TABLES[patch.table];
  if (!spec) return [];

  if (patch.op === "insert") {
    const set = { ...patch.set };
    if (spec.pk.length === 1 && !(spec.pk[0] in set)) {
      set[spec.pk[0]] = patch.id;
    }
    const cols = Object.keys(set).sort();
    return [
      {
        sql:
          `INSERT INTO ${patch.table} (${cols.join(", ")}) ` +
          `VALUES (${cols.map(() => "?").join(", ")})`,
        params: cols.map((c) => set[c]),
      },
    ];
  }

  const key = patchKey(patch, spec);
  if (!key) return [];
  const where = spec.pk.map((col) => `${col} = ?`).join(" AND ");
  const keyParams = spec.pk.map((col) => key[col]);

  if (patch.op === "update") {
    const set = patch.set ?? {};
    const cols = Object.keys(set).sort();
    return [
      {
        sql:
          `UPDATE ${patch.table} SET ` +
          `${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${where}`,
        params: [...cols.map((c) => set[c]), ...keyParams],
      },
    ];
  }

  return [
    {
      sql: `DELETE FROM ${patch.table} WHERE ${where}`,
      params: keyParams,
    },
  ];
}

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
  // statement rolls the whole proposal back.
  const rawPatches = JSON.parse(row.patches) as unknown[];
  const patches: Patch[] = [];
  for (const [i, raw] of rawPatches.entries()) {
    const errors = validatePatch(raw);
    const patch = parsePatch(raw);
    if (errors.length > 0 || !patch) {
      return fail("invalid_patch", `patch[${i}]: ${errors.join("; ")}`);
    }
    patches.push(patch);
  }

  const statements = patches.flatMap((patch) =>
    applyStatements(patch).map(({ sql, params }) => {
      const stmt = db.prepare(sql);
      return params.length ? stmt.bind(...params) : stmt;
    }),
  );
  statements.push(
    db
      .prepare(
        `UPDATE proposals SET status = 'applied', decided_at = ?, ` +
          `decided_by = ?, decision_note = ? WHERE id = ?`,
      )
      .bind(now, input.decided_by, input.note ?? null, id),
  );

  try {
    await db.batch(statements);
  } catch (e) {
    return fail("apply_failed", e instanceof Error ? e.message : String(e));
  }
  return { ok: true as const, status: "applied" };
}
