import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CASES_PATH = ROOT / "scripts/term-search-eval-cases.json"
MODEL = "@cf/baai/bge-m3"
OLLAMA_MODEL = "bge-m3:567m-fp16"
EMBED_BATCH = 16
RERANK_MODEL_ID = "BAAI/bge-reranker-base"
RERANK_MODEL_DIR = ROOT / "scripts/out/models/bge-reranker-base"
RERANK_WINDOW = 10
STOPWORDS = {
    "a", "an", "and", "are", "at", "be", "by", "card", "for", "from",
    "in", "is", "of", "on", "or", "the", "to", "with",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_terms(seed_path):
    connection = sqlite3.connect(":memory:")
    for migration in sorted((ROOT / "packages/mcp-worker/migrations").glob("*.sql")):
        connection.executescript(migration.read_text())
    connection.executescript(seed_path.read_text())
    connection.row_factory = sqlite3.Row
    terms = [
        dict(row) for row in connection.execute(
            "SELECT t.id, t.card_id, c.name AS card_name, t.kind, t.text, "
            "t.effective_from, t.effective_to FROM terms t "
            "JOIN cards c ON c.id = t.card_id ORDER BY t.id"
        )
    ]
    connection.close()
    return terms, digest(seed_path)


def eligible_terms(terms, as_of, card_id=None):
    date.fromisoformat(as_of)
    return [
        term for term in terms
        if (card_id is None or term["card_id"] == card_id)
        and (term["effective_from"] is None or term["effective_from"] <= as_of)
        and (term["effective_to"] is None or term["effective_to"] >= as_of)
    ]


def load_cases(path, terms):
    return validate_cases(json.loads(path.read_text())["cases"], terms)


def validate_cases(cases, terms):
    if not isinstance(cases, list) or not cases:
        raise ValueError("cases must be a nonempty array")
    seen = set()
    cards = {term["card_id"] for term in terms}
    for case in cases:
        case_id = case["id"]
        if not isinstance(case_id, str) or not case_id or case_id in seen:
            raise ValueError(f"duplicate or invalid case id: {case_id}")
        seen.add(case_id)
        if not isinstance(case["query"], str) or not case["query"].strip():
            raise ValueError(f"empty query: {case_id}")
        if case["language"] not in ("en", "zh", "yue"):
            raise ValueError(f"unknown language: {case_id}")
        card_id = case["card_id"]
        if card_id is not None and card_id not in cards:
            raise ValueError(f"unknown card: {case_id}")
        available = {
            term["id"] for term in eligible_terms(terms, case["as_of"], card_id)
        }
        labels = case["relevant_ids"]
        if not isinstance(labels, list) or len(labels) != len(set(labels)):
            raise ValueError(f"invalid labels: {case_id}")
        if set(labels) - available:
            raise ValueError(f"inactive, missing or wrong-card label: {case_id}")
    return cases


def tokens(text):
    result = set()
    for part in re.findall(r"[a-z0-9]+|[\u3400-\u9fff]+", text.lower()):
        if "\u3400" <= part[0] <= "\u9fff":
            result.update(part[i:i + 2] for i in range(len(part) - 1))
        elif len(part) > 1 and part not in STOPWORDS:
            result.add(part)
    return result


def term_text(term):
    return f'{term["card_name"]} {term["kind"]} {term["text"]}'


def lexical_search(query, terms, top_k=5):
    query_tokens = tokens(query)
    if not query_tokens:
        return []
    documents = {term["id"]: tokens(term_text(term)) for term in terms}
    frequencies = Counter(
        token for words in documents.values() for token in words
    )
    ranks = []
    for term in terms:
        matches = query_tokens & documents[term["id"]]
        if matches:
            score = sum(
                math.log1p((len(terms) + 1) / (frequencies[token] + 1))
                for token in matches
            )
            ranks.append((score, term["id"]))
    ranks.sort(key=lambda row: (-row[0], row[1]))
    return [term_id for _, term_id in ranks[:top_k]]


def cosine(left, right):
    if len(left) != len(right) or not left:
        raise ValueError("embedding dimensions differ")
    norm = math.sqrt(sum(value * value for value in left))
    other_norm = math.sqrt(sum(value * value for value in right))
    if norm == 0 or other_norm == 0:
        raise ValueError("embedding must be nonzero")
    return sum(a * b for a, b in zip(left, right)) / (norm * other_norm)


def semantic_search(query_vector, terms, vectors, top_k=5):
    ranks = [
        (cosine(query_vector, vectors[term["id"]]), term["id"])
        for term in terms
    ]
    ranks.sort(key=lambda row: (-row[0], row[1]))
    return [term_id for _, term_id in ranks[:top_k]]


def sigmoid(value):
    return 1 / (1 + math.exp(-value))


def load_reranker(model_dir=RERANK_MODEL_DIR):
    try:
        import onnxruntime
        from tokenizers import Tokenizer
    except ImportError as error:
        raise RuntimeError(
            "--rerank needs `onnxruntime` and `tokenizers` in the running "
            "Python (e.g. `uv venv scripts/out/venv && uv pip install "
            "--python scripts/out/venv/bin/python onnxruntime tokenizers`, "
            "then run with scripts/out/venv/bin/python)"
        ) from error
    missing = [
        name for name in ("model.onnx", "tokenizer.json")
        if not (model_dir / name).is_file()
    ]
    if missing:
        raise RuntimeError(
            f"reranker files missing under {model_dir}: {missing}; download "
            f"onnx/model.onnx and tokenizer.json from {RERANK_MODEL_ID} on "
            "Hugging Face"
        )
    tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
    session = onnxruntime.InferenceSession(
        str(model_dir / "model.onnx"), providers=["CPUExecutionProvider"]
    )
    return tokenizer, session


def rerank_pairs(session, tokenizer, pairs, batch=32, max_length=512):
    names = {item.name for item in session.get_inputs()}
    scores = []
    for start in range(0, len(pairs), batch):
        encodings = [
            tokenizer.encode(query, document) for query, document
            in pairs[start:start + batch]
        ]
        width = max(min(len(item.ids), max_length) for item in encodings)
        inputs = {}
        if "input_ids" in names:
            inputs["input_ids"] = [
                item.ids[:max_length] + [0] * (width - min(len(item.ids), max_length))
                for item in encodings
            ]
        if "attention_mask" in names:
            inputs["attention_mask"] = [
                item.attention_mask[:max_length]
                + [0] * (width - min(len(item.attention_mask), max_length))
                for item in encodings
            ]
        if "token_type_ids" in names:
            inputs["token_type_ids"] = [
                item.type_ids[:max_length]
                + [0] * (width - min(len(item.type_ids), max_length))
                for item in encodings
            ]
        if not inputs:
            raise ValueError("reranker session exposes no known inputs")
        logits = session.run(None, inputs)[0]
        scores.extend(sigmoid(float(row[0] if hasattr(row, "__len__") else row)) for row in logits)
    return scores


def summarize_rerank(cases, ranked):
    positive_top1 = []
    negative_top1 = []
    gold_scores = []
    for case in cases:
        rows = ranked.get(case["id"], [])
        if not rows:
            continue
        top1 = rows[0]["rerank_score"]
        by_id = {row["term_id"]: row["rerank_score"] for row in rows}
        if case["relevant_ids"]:
            positive_top1.append(top1)
            gold_scores.extend(
                by_id[gold] for gold in case["relevant_ids"] if gold in by_id
            )
        else:
            negative_top1.append(top1)
    summary = {
        "positive_top1": _score_stats(positive_top1),
        "negative_top1": _score_stats(negative_top1),
        "positive_gold": _score_stats(gold_scores),
    }
    if gold_scores and negative_top1:
        summary["separation_margin"] = min(gold_scores) - max(negative_top1)
    return summary


def _score_stats(values):
    if not values:
        return None
    return {
        "min": round(min(values), 4),
        "max": round(max(values), 4),
        "mean": round(sum(values) / len(values), 4),
        "count": len(values),
    }


def check_vectors(vectors, count):
    if not isinstance(vectors, list) or len(vectors) != count:
        raise ValueError("embedding count differs from input count")
    for vector in vectors:
        if (not isinstance(vector, list) or not vector
                or any(isinstance(value, bool)
                       or not isinstance(value, (int, float))
                       or not math.isfinite(value) for value in vector)):
            raise ValueError("invalid embedding response")
    if len({len(vector) for vector in vectors}) != 1:
        raise ValueError("embedding dimensions differ")
    return vectors


def parse_embeddings(body, count):
    data = json.loads(body)["data"]
    if not isinstance(data, list) or len(data) != count:
        raise ValueError("embedding count differs from input count")
    by_index = {}
    for row in data:
        index = row["index"]
        if (not isinstance(index, int) or isinstance(index, bool)
                or not 0 <= index < count or index in by_index):
            raise ValueError("invalid embedding response")
        by_index[index] = row["embedding"]
    return check_vectors([by_index[index] for index in range(count)], count)


def parse_ollama_embeddings(body, count):
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("invalid embedding response")
    if payload.get("error"):
        raise ValueError(f"ollama error: {payload['error']}")
    return check_vectors(payload.get("embeddings"), count)


def embed(texts, account_id, token):
    endpoint = (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/embeddings"
    )
    vectors = []
    for start in range(0, len(texts), EMBED_BATCH):
        batch = texts[start:start + EMBED_BATCH]
        request = urllib.request.Request(
            endpoint,
            data=json.dumps({"model": MODEL, "input": batch}).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                vectors.extend(parse_embeddings(response.read(), len(batch)))
        except urllib.error.HTTPError as error:
            raise RuntimeError(
                f"Workers AI request failed with HTTP {error.code}"
            ) from error
    if len({len(vector) for vector in vectors}) != 1:
        raise ValueError("inconsistent embedding dimensions")
    return vectors


def embed_ollama(texts):
    endpoint = "http://127.0.0.1:11434/api/embed"
    vectors = []
    for start in range(0, len(texts), EMBED_BATCH):
        batch = texts[start:start + EMBED_BATCH]
        request = urllib.request.Request(
            endpoint,
            data=json.dumps({"model": OLLAMA_MODEL, "input": batch}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                vectors.extend(
                    parse_ollama_embeddings(response.read(), len(batch))
                )
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:200]
            raise RuntimeError(
                f"Ollama request failed with HTTP {error.code}: {detail}"
            ) from error
        except urllib.error.URLError as error:
            raise RuntimeError(
                f"Ollama not reachable at {endpoint} ({error.reason}); "
                f"run `ollama serve` and `ollama pull {OLLAMA_MODEL}` "
                "first -- no cloud fallback for --provider ollama"
            ) from error
    if len({len(vector) for vector in vectors}) != 1:
        raise ValueError("inconsistent embedding dimensions")
    return vectors


def score_results(cases, predictions):
    positive = [case for case in cases if case["relevant_ids"]]
    negative = [case for case in cases if not case["relevant_ids"]]
    missed = {}
    recalls = []
    hits = 0
    for case in positive:
        expected = set(case["relevant_ids"])
        found = set(predictions[case["id"]][:5])
        missing = sorted(expected - found)
        if missing:
            missed[case["id"]] = missing
        recalls.append(len(expected & found) / len(expected))
        hits += bool(expected & found)
    return {
        "positive_cases": len(positive),
        "negative_cases": len(negative),
        "recall_at_5": sum(recalls) / len(recalls) if recalls else None,
        "hit_at_5": hits / len(positive) if positive else None,
        "negative_false_hits": sum(
            bool(predictions[case["id"]]) for case in negative
        ),
        "missed_ids": missed,
    }


def score_by_language(cases, predictions):
    return {
        language: score_results(
            [case for case in cases if case["language"] == language],
            predictions,
        )
        for language in ("yue", "zh", "en")
    }


def main():
    parser = argparse.ArgumentParser(
        description="Manual Term discovery eval; --semantic embeds via paid "
        "Workers AI or via a local Ollama server (--provider ollama, free)"
    )
    parser.add_argument("--semantic", action="store_true")
    parser.add_argument(
        "--provider", choices=["cloudflare", "ollama"], default="cloudflare",
        help="embedding backend for --semantic; ollama also implies --semantic",
    )
    parser.add_argument("--seed", type=Path, default=ROOT / "seed/seed.sql")
    parser.add_argument("--cases", type=Path, default=CASES_PATH)
    parser.add_argument(
        "--rerank", action="store_true",
        help="rerank the semantic candidates with a local "
        f"{RERANK_MODEL_ID} ONNX cross-encoder",
    )
    args = parser.parse_args()
    semantic = args.semantic or args.provider == "ollama"
    if args.rerank and not semantic:
        parser.error("--rerank reranks semantic candidates; enable --semantic or --provider ollama")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if (semantic and args.provider == "cloudflare"
            and (not token or not account_id)):
        parser.error(
            "--semantic needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID "
            "(or use --provider ollama for a local model)"
        )

    terms, corpus_hash = load_terms(args.seed)
    if json.loads(args.cases.read_text())["corpus_sha256"] != corpus_hash:
        parser.error("seed changed since labels were pinned; review and relabel before rerunning")
    cases = load_cases(args.cases, terms)
    report = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "corpus_sha256": corpus_hash,
        "cases_sha256": digest(args.cases),
        "terms": len(terms),
        "cases": len(cases),
        "top_k": 5,
        "lexical": {},
        "semantic": None,
        "rerank": None,
    }
    lexical = {}
    durations = []
    for case in cases:
        available = eligible_terms(terms, case["as_of"], case["card_id"])
        start = time.perf_counter()
        lexical[case["id"]] = lexical_search(case["query"], available)
        durations.append((time.perf_counter() - start) * 1000)
    report["lexical"] = {
        **score_results(cases, lexical),
        "by_language": score_by_language(cases, lexical),
        "mean_query_ms": sum(durations) / len(durations),
        "predictions": lexical,
    }

    if semantic:
        def embed_batch(texts):
            if args.provider == "ollama":
                return embed_ollama(texts)
            return embed(texts, account_id, token)

        document_texts = [term_text(term) for term in terms]
        started = time.perf_counter()
        document_vectors = embed_batch(document_texts)
        build_ms = (time.perf_counter() - started) * 1000
        vectors = dict(zip((term["id"] for term in terms), document_vectors))
        wide = {}
        durations = []
        for case in cases:
            started = time.perf_counter()
            query_vector = embed_batch([case["query"]])[0]
            available = eligible_terms(terms, case["as_of"], case["card_id"])
            wide[case["id"]] = semantic_search(
                query_vector, available, vectors, RERANK_WINDOW
            )
            durations.append((time.perf_counter() - started) * 1000)
        predictions = {
            case_id: hits[:5] for case_id, hits in wide.items()
        }
        report["semantic"] = {
            "provider": args.provider,
            "model": OLLAMA_MODEL if args.provider == "ollama" else MODEL,
            "method": "exact local cosine (Vectorize relevance proxy, not ANN)",
            "index_build_ms": build_ms,
            "mean_query_ms": sum(durations) / len(durations),
            "embedding_requests": (
                math.ceil(len(terms) / EMBED_BATCH) + len(cases)
            ),
            "embedded_texts": len(terms) + len(cases),
            "embedded_characters": sum(map(len, document_texts)) + sum(
                len(case["query"]) for case in cases
            ),
            "vector_dimensions": len(document_vectors[0]),
            **score_results(cases, predictions),
            "by_language": score_by_language(cases, predictions),
            "predictions": predictions,
        }

    if args.rerank:
        term_by_id = {term["id"]: term for term in terms}
        tokenizer, session = load_reranker()
        ranked = {}
        started = time.perf_counter()
        for case in cases:
            candidates = wide[case["id"]]
            pairs = [
                (case["query"], term_text(term_by_id[term_id]))
                for term_id in candidates
            ]
            scores = rerank_pairs(session, tokenizer, pairs)
            ranked[case["id"]] = [
                {"term_id": term_id, "rerank_score": round(score, 4)}
                for term_id, score in sorted(
                    zip(candidates, scores), key=lambda row: -row[1]
                )
            ]
        rerank_ms = (time.perf_counter() - started) * 1000
        rerank_predictions = {
            case_id: [row["term_id"] for row in rows[:5]]
            for case_id, rows in ranked.items()
        }
        report["rerank"] = {
            "model": f"{RERANK_MODEL_ID} (local ONNX; Workers AI serving may differ numerically)",
            "rerank_window": RERANK_WINDOW,
            "mean_case_ms": rerank_ms / len(cases),
            **score_results(cases, rerank_predictions),
            **summarize_rerank(cases, ranked),
            "ranked": ranked,
        }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, sqlite3.Error, OSError, KeyError) as error:
        print(f"term-search eval: {error}", file=sys.stderr)
        sys.exit(1)
