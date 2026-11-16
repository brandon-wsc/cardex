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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
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

async function embedBatched(
  deps: TermIndexDeps,
  texts: string[],
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    vectors.push(...(await deps.embed(texts.slice(start, start + EMBED_BATCH))));
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
    .prepare("SELECT term_id FROM term_index_dirty")
    .all<{ term_id: string }>();
  const dirtyIds = dirtyRows.map((r) => r.term_id);

  const { results: terms } = await db.prepare(TERMS_DOC_SQL).all<DocTerm>();

  // The binding cannot list index ids, so deletes are only ever known via
  // the apply-time mark: a dirty id absent from D1 is a deleted term.
  const gone = dirtyIds.filter((id) => !terms.some((t) => t.id === id));
  if (gone.length) await deps.deleteByIds(gone);

  const docs = new Map(terms.map((t) => [t.id, termDocument(t)]));
  const hashes = new Map(
    await Promise.all(
      terms.map(
        async (t) => [t.id, await embedHash(docs.get(t.id) ?? "")] as const,
      ),
    ),
  );

  const stored = terms.length
    ? await deps.getByIds(terms.map((t) => t.id))
    : [];
  const storedHash = new Map(
    stored.map((v) => [v.id, v.metadata?.embed_hash ?? null]),
  );

  const stale = terms.filter((t) => storedHash.get(t.id) !== hashes.get(t.id));
  if (stale.length) {
    const vectors = await embedBatched(
      deps,
      stale.map((t) => docs.get(t.id) ?? ""),
    );
    await deps.upsert(
      stale.map((t, i) =>
        vectorRecord(t, vectors[i], hashes.get(t.id) ?? ""),
      ),
    );
  }

  if (dirtyIds.length) {
    await db
      .prepare(
        `DELETE FROM term_index_dirty WHERE term_id IN (${placeholders(dirtyIds.length)})`,
      )
      .bind(...dirtyIds)
      .run();
  }

  return {
    drained: dirtyIds.length,
    deleted: gone,
    upserted: stale.map((t) => t.id),
    unchanged: terms.length - stale.length,
  };
}
