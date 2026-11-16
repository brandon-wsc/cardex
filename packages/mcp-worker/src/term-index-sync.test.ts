import {
  applyD1Migrations,
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import worker from "./index";
import {
  embedHash,
  reconcileTermIndex,
  termDocument,
} from "./term-index-sync";
import type { TermIndexDeps } from "./term-index-sync";

// Specs for the scheduled term-index reconcile (ADR 0015): dirty marks are
// the delete record, the embed_hash sweep is the insert/update reconciler,
// and a failed run keeps its marks for the next cron tick. Deps are injected
// fakes — no billable AI or Vectorize calls in tests.
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

interface StoredVector {
  id: string;
  metadata: { embed_hash?: string };
}

function fakeIndexDeps(stored: StoredVector[] = []) {
  const vectors = new Map(stored.map((v) => [v.id, v]));
  const calls = {
    embedded: [] as string[][],
    getByIdsBatches: [] as string[][],
    upserted: [] as { id: string; metadata: Record<string, string> }[],
    deleted: [] as string[],
  };
  const deps: TermIndexDeps = {
    embed: (texts) => {
      calls.embedded.push([...texts]);
      return Promise.resolve(texts.map(() => [0.1, 0.2]));
    },
    getByIds: (ids) => {
      calls.getByIdsBatches.push([...ids]);
      if (ids.length > 20) {
        return Promise.reject(
          new Error(`Vectorize getByIds limit exceeded: ${ids.length} > 20`),
        );
      }
      return Promise.resolve(
        ids.flatMap((id) => {
          const v = vectors.get(id);
          return v ? [{ id: v.id, metadata: v.metadata }] : [];
        }),
      );
    },
    upsert: (vs) => {
      calls.upserted.push(...vs);
      for (const v of vs) vectors.set(v.id, { id: v.id, metadata: v.metadata });
      return Promise.resolve({ count: vs.length, ids: vs.map((v) => v.id) });
    },
    deleteByIds: (ids) => {
      calls.deleted.push(...ids);
      for (const id of ids) vectors.delete(id);
      return Promise.resolve({ count: ids.length, ids });
    },
  };
  return { deps, calls, vectors };
}

const markDirty = async (...ids: string[]) => {
  for (const id of ids) {
    await tenv.DB
      .prepare(
        "INSERT OR REPLACE INTO term_index_dirty (term_id, queued_at) VALUES (?, ?)",
      )
      .bind(id, "2026-11-16T00:00:00.000Z")
      .run();
  }
};

const dirtyIds = async () => {
  const { results } = await tenv.DB
    .prepare("SELECT term_id FROM term_index_dirty ORDER BY term_id")
    .all<{ term_id: string }>();
  return results.map((r) => r.term_id);
};

// The document and its hash must stay byte-identical with
// scripts/term_search_index.py — a drifted doc format silently re-embeds
// every term on every run (the hash is what a reconcile skips on).
describe("termDocument / embedHash", () => {
  it("builds the embedded document as 'card_name kind text'", async () => {
    const doc = termDocument({
      card_name: "HSBC Red Credit Card",
      kind: "cap",
      text: "Illustrative dining rebate cap of HK$300 per statement month.",
    });
    expect(doc).toBe(
      "HSBC Red Credit Card cap " +
        "Illustrative dining rebate cap of HK$300 per statement month.",
    );
    // Hash pinned to scripts/term_search_index.py's output for the same doc
    // — the two implementations must agree or the sweep never converges.
    expect(await embedHash(doc)).toBe(
      "3727a1b5f14fe113e0929692df40518786c4d9e017cb7efa3e14cce628ca80ed",
    );
  });
});

describe("reconcileTermIndex", () => {
  it("upserts a fresh vector for a dirty term still live in D1", async () => {
    await markDirty("term_hsbc_dining_cap");
    const { deps, calls } = fakeIndexDeps();
    await reconcileTermIndex(tenv.DB, deps);
    const hit = calls.upserted.find((v) => v.id === "term_hsbc_dining_cap");
    expect(hit).toBeDefined();
    expect(hit?.metadata).toMatchObject({
      card_id: "card_hsbc_red",
      kind: "cap",
      embed_hash:
        "3727a1b5f14fe113e0929692df40518786c4d9e017cb7efa3e14cce628ca80ed",
    });
    expect(await dirtyIds()).toEqual([]);
  });

  it("deletes the vector for a dirty term gone from D1", async () => {
    await markDirty("term_ghost");
    const { deps, calls } = fakeIndexDeps();
    await reconcileTermIndex(tenv.DB, deps);
    expect(calls.deleted).toContain("term_ghost");
    expect(await dirtyIds()).toEqual([]);
  });

  it("re-embeds a live term whose stored embed_hash no longer matches its document", async () => {
    const { deps, calls } = fakeIndexDeps([
      { id: "term_hsbc_dining_cap", metadata: { embed_hash: "stale-hash" } },
    ]);
    await reconcileTermIndex(tenv.DB, deps);
    expect(calls.embedded.flat()).toContain(
      "HSBC Red Credit Card cap " +
        "Illustrative dining rebate cap of HK$300 per statement month.",
    );
    const hit = calls.upserted.find((v) => v.id === "term_hsbc_dining_cap");
    expect(hit?.metadata.embed_hash).toBe(
      "3727a1b5f14fe113e0929692df40518786c4d9e017cb7efa3e14cce628ca80ed",
    );
  });

  it("upserts a term the index has never seen", async () => {
    const { deps, calls } = fakeIndexDeps();
    await reconcileTermIndex(tenv.DB, deps);
    const { results } = await tenv.DB
      .prepare("SELECT COUNT(*) AS n FROM terms")
      .all<{ n: number }>();
    expect(calls.upserted.map((v) => v.id)).toContain("term_hsbc_dining_cap");
    expect(calls.upserted.length).toBe(results[0].n);
  });

  it("embeds nothing when every live term's stored hash still matches", async () => {
    const stored: StoredVector[] = [];
    const { results: terms } = await tenv.DB
      .prepare(
        "SELECT t.id, c.name AS card_name, t.kind, t.text " +
          "FROM terms t JOIN cards c ON c.id = t.card_id",
      )
      .all<{ id: string; card_name: string; kind: string; text: string }>();
    for (const term of terms) {
      stored.push({
        id: term.id,
        metadata: { embed_hash: await embedHash(termDocument(term)) },
      });
    }
    const { deps, calls } = fakeIndexDeps(stored);
    const res = await reconcileTermIndex(tenv.DB, deps);
    expect(calls.embedded).toEqual([]);
    expect(calls.upserted).toEqual([]);
    expect(res.unchanged).toBe(terms.length);
  });

  it("keeps the dirty rows for the next run when the embed call fails", async () => {
    await markDirty("term_hsbc_dining_cap");
    const { deps } = fakeIndexDeps();
    deps.embed = () => Promise.reject(new Error("ai down"));
    await expect(reconcileTermIndex(tenv.DB, deps)).rejects.toThrow("ai down");
    expect(await dirtyIds()).toEqual(["term_hsbc_dining_cap"]);
  });

  it("fails the run and keeps the marks when embed returns fewer vectors than texts", async () => {
    await markDirty("term_hsbc_dining_cap");
    const { deps } = fakeIndexDeps();
    deps.embed = (texts) =>
      Promise.resolve(texts.slice(1).map(() => [0.1, 0.2]));
    await expect(reconcileTermIndex(tenv.DB, deps)).rejects.toThrow(
      /returned \d+ vectors for \d+ texts/,
    );
    expect(await dirtyIds()).toEqual(["term_hsbc_dining_cap"]);
  });

  it("fails the run when embeddings come back with inconsistent dimensions", async () => {
    const { deps } = fakeIndexDeps();
    deps.embed = (texts) =>
      Promise.resolve(texts.map((_, i) => (i === 0 ? [0.1] : [0.1, 0.2])));
    await expect(reconcileTermIndex(tenv.DB, deps)).rejects.toThrow(
      "inconsistent embedding dimensions",
    );
  });

  it("reports what it changed", async () => {
    await markDirty("term_ghost", "term_hsbc_dining_cap");
    const { deps } = fakeIndexDeps();
    const res = await reconcileTermIndex(tenv.DB, deps);
    expect(res.drained).toBe(2);
    expect(res.deleted).toEqual(["term_ghost"]);
    expect(res.upserted.length).toBeGreaterThan(0);
    expect(res).toHaveProperty("unchanged");
  });

  it("chunks getByIds to at most 20 ids per call", async () => {
    const extraStmts = Array.from({ length: 25 }, (_, i) =>
      tenv.DB
        .prepare(
          "INSERT INTO terms (id, card_id, kind, text, source_url, last_verified_at) " +
            "VALUES (?, 'card_hsbc_red', 'cap', ?, 'https://example.invalid', '2026-11-01')",
        )
        .bind(`term_extra_${i}`, `Extra term ${i}`),
    );
    await tenv.DB.batch(extraStmts);
    const { deps, calls } = fakeIndexDeps();
    await reconcileTermIndex(tenv.DB, deps);
    expect(calls.getByIdsBatches.length).toBeGreaterThan(1);
    expect(
      Math.max(...calls.getByIdsBatches.map((b) => b.length)),
    ).toBeLessThanOrEqual(20);
  });

  it("drains more than 100 dirty rows without hitting D1 bind-parameter limits", async () => {
    const ghostIds = Array.from({ length: 120 }, (_, i) => `term_ghost_${i}`);
    await markDirty(...ghostIds);
    const { deps, calls } = fakeIndexDeps();
    const res = await reconcileTermIndex(tenv.DB, deps);
    expect(res.drained).toBe(120);
    expect(calls.deleted).toHaveLength(120);
    expect(await dirtyIds()).toEqual([]);
  });

  it("preserves a dirty mark updated with a newer queued_at while reconcile is in flight", async () => {
    await markDirty("term_hsbc_dining_cap");
    const { deps } = fakeIndexDeps();
    const baseEmbed = deps.embed;
    let bumped = false;
    deps.embed = async (texts) => {
      if (!bumped) {
        bumped = true;
        // Simulate an in-flight proposal deleting the term after reconcile
        // snapshotted term_index_dirty and terms.
        await tenv.DB
          .prepare(
            "INSERT OR REPLACE INTO term_index_dirty (term_id, queued_at) VALUES (?, ?)",
          )
          .bind("term_hsbc_dining_cap", "2026-11-16T00:05:00.000Z")
          .run();
      }
      return baseEmbed(texts);
    };
    await reconcileTermIndex(tenv.DB, deps);
    expect(await dirtyIds()).toEqual(["term_hsbc_dining_cap"]);
  });
});

describe("scheduled handler", () => {
  const controller = () =>
    ({
      scheduledTime: Date.now(),
      cron: "*/15 * * * *",
    }) as ScheduledController;

  const envWithIndex = (
    deps: TermIndexDeps,
    aiRun: (model: string, input: { text: string[] }) => Promise<unknown>,
  ) =>
    ({
      DB: tenv.DB,
      AI: { run: aiRun },
      TERMS_INDEX: {
        getByIds: deps.getByIds,
        upsert: deps.upsert,
        deleteByIds: deps.deleteByIds,
      },
    }) as unknown as Env;

  it("skips the run silently when the index bindings are absent", async () => {
    const ctx = createExecutionContext();
    worker.scheduled(
      controller(),
      { DB: tenv.DB } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await dirtyIds()).toEqual([]);
  });

  it("drains dirty marks through the index bindings when they are present", async () => {
    await markDirty("term_ghost");
    const { deps, calls } = fakeIndexDeps();
    const env = envWithIndex(deps, (_model, input) =>
      Promise.resolve({ data: input.text.map(() => [0.1, 0.2]) }),
    );
    const ctx = createExecutionContext();
    worker.scheduled(controller(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(calls.deleted).toContain("term_ghost");
    expect(await dirtyIds()).toEqual([]);
  });

  it("keeps the dirty marks when the reconcile inside the handler throws", async () => {
    await markDirty("term_hsbc_dining_cap");
    const { deps } = fakeIndexDeps();
    const env = envWithIndex(deps, () =>
      Promise.reject(new Error("ai down")),
    );
    const ctx = createExecutionContext();
    worker.scheduled(controller(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await dirtyIds()).toEqual(["term_hsbc_dining_cap"]);
  });
});
