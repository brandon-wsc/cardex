// ADR 0015: the cardex-terms index is kept fresh by a scheduled reconcile,
// not by request-path writes. decideProposal lands one term_index_dirty row
// per touched term id in the same atomic batch as the facts; the cron
// handler drains them and then sweeps every live term's stored embed_hash
// against the document D1 would produce, so a missed mark can never leave a
// stale vector behind. The index still only ever holds pointers — term text
// is embedded, never stored.
//
// The document shape and embed_hash are byte-identical with
// scripts/term_search_index.py: the two implementations share the index,
// so a drifted format would re-embed every term on every reconcile.

const TERMS_DOC_SQL =
  "SELECT t.id, t.card_id, c.name AS card_name, t.kind, t.text, " +
  "t.effective_from, t.effective_to FROM terms t " +
  "JOIN cards c ON c.id = t.card_id ORDER BY t.id";

// Matches EMBED_BATCH in term_search_eval.py — one AI call per 16 texts.
const EMBED_BATCH = 16;
// Cloudflare Vectorize getByIds caps at 20 IDs per call; upsert/deleteByIds
// cap at 1000 per call. D1 caps bound parameters at 100 per statement.
const VECTORIZE_GET_BATCH = 20;
const VECTORIZE_MUTATE_BATCH = 1000;
const D1_DELETE_BATCH = 45;

export interface DocTerm {
  id: string;
  card_id: string;
  card_name: string;
  kind: string;
  text: string;
  effective_from: string | null;
  effective_to: string | null;
}

export interface TermIndexDeps {
  embed(texts: string[]): Promise<number[][]>;
  getByIds(
    ids: string[],
  ): Promise<{ id: string; metadata?: { embed_hash?: string } | null }[]>;
  upsert(
    vectors: {
      id: string;
      values: number[];
      metadata: Record<string, string>;
    }[],
  ): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export function termDocument(term: {
  card_name: string;
  kind: string;
  text: string;
}): string {
  return `${term.card_name} ${term.kind} ${term.text}`;
}

export async function embedHash(document: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(document),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function vectorRecord(term: DocTerm, values: number[], hash: string) {
  const metadata: Record<string, string> = {
    card_id: term.card_id,
    kind: term.kind,
    embed_hash: hash,
  };
  if (term.effective_from !== null) metadata.effective_from = term.effective_from;
  if (term.effective_to !== null) metadata.effective_to = term.effective_to;
  return { id: term.id, values, metadata };
}

// Same guards as term_search_index.py: a short embed response or mixed
// dimensions must fail the run — the dirty marks stay for the next tick —
// never zip a missing slot into an upsert as `values: undefined`.
async function embedBatched(
  deps: TermIndexDeps,
  texts: string[],
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const out = await deps.embed(batch);
    if (out.length !== batch.length) {
      throw new Error(
        `embed returned ${out.length} vectors for ${batch.length} texts`,
      );
    }
    vectors.push(...out);
  }
  if (new Set(vectors.map((v) => v.length)).size > 1) {
    throw new Error("inconsistent embedding dimensions");
  }
  return vectors;
}

// One reconcile run: dirty deletes first, then the hash sweep. A throw
// anywhere leaves every dirty row in place — upserts and deletes are
// idempotent, so the next cron tick simply redoes the work.
export async function reconcileTermIndex(
  db: D1Database,
  deps: TermIndexDeps,
): Promise<{
  drained: number;
  deleted: string[];
  upserted: string[];
  unchanged: number;
}> {
  const { results: dirtyRows } = await db
    .prepare("SELECT term_id, queued_at FROM term_index_dirty")
    .all<{ term_id: string; queued_at: string }>();
  const dirtyIds = dirtyRows.map((r) => r.term_id);

  const { results: terms } = await db.prepare(TERMS_DOC_SQL).all<DocTerm>();

  // The binding cannot list index ids, so deletes are only ever known via
  // the apply-time mark: a dirty id absent from D1 is a deleted term.
  const gone = dirtyIds.filter((id) => !terms.some((t) => t.id === id));
  for (const batch of chunk(gone, VECTORIZE_MUTATE_BATCH)) {
    await deps.deleteByIds(batch);
  }

  const docs = new Map(terms.map((t) => [t.id, termDocument(t)]));
  const hashes = new Map(
    await Promise.all(
      terms.map(
        async (t) => [t.id, await embedHash(docs.get(t.id) ?? "")] as const,
      ),
    ),
  );

  const stored: { id: string; metadata?: { embed_hash?: string } | null }[] = [];
  for (const batch of chunk(
    terms.map((t) => t.id),
    VECTORIZE_GET_BATCH,
  )) {
    stored.push(...(await deps.getByIds(batch)));
  }
  const storedHash = new Map(
    stored.map((v) => [v.id, v.metadata?.embed_hash ?? null]),
  );

  const stale = terms.filter((t) => storedHash.get(t.id) !== hashes.get(t.id));
  if (stale.length) {
    const vectors = await embedBatched(
      deps,
      stale.map((t) => docs.get(t.id) ?? ""),
    );
    const records = stale.map((t, i) =>
      vectorRecord(t, vectors[i], hashes.get(t.id) ?? ""),
    );
    for (const batch of chunk(records, VECTORIZE_MUTATE_BATCH)) {
      await deps.upsert(batch);
    }
  }

  // Drain only the exact (term_id, queued_at) marks we snapshotted, chunked
  // under D1's 100-parameter limit. Every mark is stamped unique (iso#uuid),
  // so an in-flight update/delete mark is never wiped — not even a re-mark
  // sharing the same millisecond timestamp.
  for (const batch of chunk(dirtyRows, D1_DELETE_BATCH)) {
    await db.batch(
      batch.map((r) =>
        db
          .prepare(
            "DELETE FROM term_index_dirty WHERE term_id = ? AND queued_at = ?",
          )
          .bind(r.term_id, r.queued_at),
      ),
    );
  }

  return {
    drained: dirtyIds.length,
    deleted: gone,
    upserted: stale.map((t) => t.id),
    unchanged: terms.length - stale.length,
  };
}
