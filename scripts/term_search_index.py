"""Manual Vectorize index builder for the ADR 0014 search_terms experiment.

Reads the curated Terms from D1 (wrangler d1 execute --local by default,
--remote for prod; the seed export is the offline fallback), embeds the same
document shape the eval and the Worker use — "card_name kind text" — with
bge-m3, and emits:

  scripts/out/terms-vectors.ndjson  ->  wrangler vectorize upsert cardex-terms --file ...
  scripts/out/stale-vector-ids.txt  ->  wrangler vectorize delete-vectors cardex-terms --ids ...

(--check-stale diffs against `wrangler vectorize list-vectors`.)

The index holds pointers only — vector id = term id, metadata is
card_id/kind/effective window/embed_hash for diffing. Fact text never enters
the index; D1 remains the sole facts store and revalidates every hit at
request time.
"""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from term_search_eval import (
    MODEL,
    OLLAMA_MODEL,
    ROOT,
    embed,
    embed_ollama,
    load_terms,
    term_text,
)

WORKER_DIR = ROOT / "packages/mcp-worker"
DEFAULT_INDEX = "cardex-terms"
DEFAULT_OUT = ROOT / "scripts" / "out"
TERMS_SQL = (
    "SELECT t.id, t.card_id, c.name AS card_name, t.kind, t.text, "
    "t.effective_from, t.effective_to FROM terms t "
    "JOIN cards c ON c.id = t.card_id ORDER BY t.id"
)


def parse_d1_results(body):
    """Return rows from `wrangler d1 execute --json` stdout."""
    payload = json.loads(body)
    if not isinstance(payload, list):
        raise ValueError("unexpected d1 execute output")
    rows = []
    for entry in payload:
        if not isinstance(entry, dict):
            raise ValueError("unexpected d1 execute output")
        if entry.get("success") is not True:
            raise ValueError(f"d1 execute failed: {json.dumps(entry)[:200]}")
        if entry.get("results") is not None:
            rows.extend(entry["results"])
    return rows


def d1_terms(remote):
    flag = "--remote" if remote else "--local"
    proc = subprocess.run(
        [
            "pnpm", "exec", "wrangler", "d1", "execute", "cardex-db",
            flag, "--json", "--command", TERMS_SQL,
        ],
        cwd=WORKER_DIR,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"wrangler d1 execute {flag} failed: {proc.stderr.strip()[:400]}"
        )
    terms = parse_d1_results(proc.stdout)
    if not terms:
        raise RuntimeError(
            f"d1 execute {flag} returned no terms — is the database seeded?"
        )
    return terms


def vector_record(term, vector):
    """One index record: id is the term id; metadata is pointers only —
    embed_hash lets a later reindex skip rows whose document did not change."""
    metadata = {
        "card_id": term["card_id"],
        "kind": term["kind"],
        "embed_hash": hashlib.sha256(term_text(term).encode()).hexdigest(),
    }
    for key in ("effective_from", "effective_to"):
        if term.get(key) is not None:
            metadata[key] = term[key]
    return {"id": term["id"], "values": vector, "metadata": metadata}


def parse_vector_ids(text):
    """Tolerantly pull vector ids out of `wrangler vectorize list-vectors`
    stdout — JSON arrays of strings or {id} objects, ndjson {id} rows, or
    plain one-id-per-line all parse."""
    ids = []
    stripped = text.strip()
    if not stripped:
        return ids
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, str):
                ids.append(item)
            elif isinstance(item, dict) and isinstance(item.get("id"), str):
                ids.append(item["id"])
        return ids
    if isinstance(payload, dict):
        for key in ("result", "vectors", "ids"):
            if isinstance(payload.get(key), list):
                return parse_vector_ids(json.dumps(payload[key]))
        return ids
    for line in stripped.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            ids.append(line.strip('"'))
            continue
        if isinstance(item, str):
            ids.append(item)
        elif isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.append(item["id"])
    return ids


def stale_ids(indexed_ids, terms):
    """Ids the index holds that no longer exist as Terms — delete candidates."""
    live = {term["id"] for term in terms}
    return sorted({i for i in indexed_ids if i not in live})


def list_indexed_ids(index_name):
    proc = subprocess.run(
        [
            "pnpm", "exec", "wrangler", "vectorize", "list-vectors",
            index_name, "--count", "1000",
        ],
        cwd=WORKER_DIR,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "wrangler vectorize list-vectors failed: "
            f"{proc.stderr.strip()[:300]}"
        )
    return parse_vector_ids(proc.stdout)


def main():
    parser = argparse.ArgumentParser(
        description="Build the cardex-terms Vectorize index from D1 Terms "
        "(ADR 0014); emits NDJSON for wrangler vectorize upsert/delete-vectors"
    )
    parser.add_argument(
        "--source",
        choices=["local", "remote", "seed"],
        default="local",
        help="where Terms come from: local D1 (default), remote D1, or the "
        "seed export (offline fallback — refresh it with pnpm export-seed)",
    )
    parser.add_argument(
        "--provider",
        choices=["ollama", "cloudflare"],
        default="ollama",
        help="embedding backend; ollama is local and free (default)",
    )
    parser.add_argument("--index-name", default=DEFAULT_INDEX)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--check-stale",
        action="store_true",
        help="diff live Term ids against the index via wrangler list-vectors "
        "and emit a stale-id delete list",
    )
    args = parser.parse_args()

    if args.source == "seed":
        terms, seed_hash = load_terms(ROOT / "seed/seed.sql")
        origin = f"seed export ({seed_hash[:12]})"
    else:
        terms = d1_terms(remote=args.source == "remote")
        origin = f"d1-{args.source}"

    embed_fn = embed_ollama
    if args.provider == "cloudflare":
        import os

        token = os.environ.get("CLOUDFLARE_API_TOKEN")
        account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
        if not token or not account_id:
            parser.error(
                "--provider cloudflare needs CLOUDFLARE_API_TOKEN and "
                "CLOUDFLARE_ACCOUNT_ID (or use --provider ollama)"
            )

        def embed_fn(texts):
            return embed(texts, account_id, token)

    document_texts = [term_text(term) for term in terms]
    vectors = embed_fn(document_texts)
    if len(vectors) != len(terms):
        raise ValueError("embedding count differs from term count")
    dims = {len(vector) for vector in vectors}
    if len(dims) != 1:
        raise ValueError("inconsistent embedding dimensions")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    vectors_path = args.out_dir / "terms-vectors.ndjson"
    with vectors_path.open("w") as handle:
        for term, vector in zip(terms, vectors):
            handle.write(json.dumps(vector_record(term, vector)) + "\n")

    stale_path = None
    stale = []
    if args.check_stale:
        stale = stale_ids(list_indexed_ids(args.index_name), terms)
        stale_path = args.out_dir / "stale-vector-ids.txt"
        stale_path.write_text("".join(f"{i}\n" for i in stale))

    report = {
        "source": origin,
        "provider": args.provider,
        "model": OLLAMA_MODEL if args.provider == "ollama" else MODEL,
        "terms": len(terms),
        "dimensions": dims.pop(),
        "vectors_file": str(vectors_path),
        "stale_ids": stale if args.check_stale else "skipped (--check-stale)",
        "next_steps": [
            f"wrangler vectorize upsert {args.index_name} --file {vectors_path}",
            (
                f"wrangler vectorize delete-vectors {args.index_name} "
                f"--ids {' '.join(stale)}"
                if args.check_stale and stale
                else "# no stale ids" if args.check_stale else
                "# rerun with --check-stale to diff against the index"
            ),
        ],
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"term-search index: {error}", file=sys.stderr)
        sys.exit(1)
