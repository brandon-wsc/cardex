import io
import json
import unittest
import urllib.error
from unittest.mock import patch

import term_search_eval as evaluation


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return self.body


class TermSearchEvalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.terms, cls.corpus_hash = evaluation.load_terms(
            evaluation.ROOT / "seed/seed.sql"
        )

    def test_loads_terms_from_pinned_d1_snapshot(self):
        self.assertGreater(len(self.terms), 20)
        self.assertIn("term_hsbc_octopus", {term["id"] for term in self.terms})
        self.assertEqual(len(self.corpus_hash), 64)

    def test_filters_expired_terms_and_card_scope_before_ranking(self):
        active = evaluation.eligible_terms(
            self.terms, "2026-11-15", "card_mox"
        )
        self.assertNotIn("term_mox_payroll", {term["id"] for term in active})
        self.assertTrue(all(term["card_id"] == "card_mox" for term in active))
        historic = evaluation.eligible_terms(
            self.terms, "2026-05-15", "card_mox"
        )
        self.assertIn("term_mox_payroll", {term["id"] for term in historic})

    def test_lexical_ranking_does_not_rank_unmatched_terms(self):
        terms = evaluation.eligible_terms(self.terms, "2026-11-15", "card_hsbc_red")
        result = evaluation.lexical_search("Octopus top-up", terms, 5)
        self.assertEqual(result[0], "term_hsbc_octopus")
        self.assertEqual(evaluation.lexical_search("xyzzynonsense", terms, 5), [])

    def test_case_labels_and_card_ids_exist_at_as_of(self):
        cases = evaluation.load_cases(evaluation.CASES_PATH, self.terms)
        self.assertEqual(
            json.loads(evaluation.CASES_PATH.read_text())["corpus_sha256"],
            self.corpus_hash,
        )
        self.assertGreaterEqual(len(cases), 12)
        self.assertTrue(any(not case["relevant_ids"] for case in cases))
        self.assertTrue(any(case["card_id"] is None for case in cases))
        self.assertTrue(any(case["as_of"] != "2026-11-15" for case in cases))
        self.assertGreaterEqual(
            sum(case["language"] == "yue" for case in cases), 5
        )

    def test_stress_cases_are_separate_and_cover_unscoped_cantonese_and_no_answer(self):
        path = evaluation.ROOT / "scripts/term-search-eval-stress-cases.json"
        stress = evaluation.load_cases(path, self.terms)
        original = evaluation.load_cases(evaluation.CASES_PATH, self.terms)
        self.assertEqual(
            json.loads(path.read_text())["corpus_sha256"], self.corpus_hash
        )
        self.assertFalse(
            {case["id"] for case in original} & {case["id"] for case in stress}
        )
        self.assertFalse(
            {case["query"].casefold().strip() for case in original}
            & {case["query"].casefold().strip() for case in stress}
        )
        self.assertGreaterEqual(
            sum(case["language"] == "yue" and case["card_id"] is None
                and bool(case["relevant_ids"]) for case in stress), 8
        )
        self.assertGreaterEqual(
            sum(case["language"] == "yue" and not case["relevant_ids"]
                for case in stress), 5
        )

    def test_metrics_count_partial_recall_and_negative_false_hits(self):
        cases = [
            {"id": "multi", "relevant_ids": ["a", "b"]},
            {"id": "none", "relevant_ids": []},
        ]
        scores = evaluation.score_results(cases, {"multi": ["a", "c"], "none": ["d"]})
        self.assertEqual(scores["positive_cases"], 1)
        self.assertEqual(scores["recall_at_5"], 0.5)
        self.assertEqual(scores["hit_at_5"], 1.0)
        self.assertEqual(scores["negative_false_hits"], 1)
        self.assertEqual(scores["negative_cases"], 1)
        self.assertEqual(scores["missed_ids"], {"multi": ["b"]})

    def test_language_breakdown_separates_cantonese_from_english(self):
        cases = [
            {"id": "cantonese", "language": "yue", "relevant_ids": ["a"]},
            {"id": "english", "language": "en", "relevant_ids": ["b"]},
        ]
        by_language = evaluation.score_by_language(
            cases, {"cantonese": ["a"], "english": ["c"]}
        )
        self.assertEqual(by_language["yue"]["recall_at_5"], 1.0)
        self.assertEqual(by_language["en"]["recall_at_5"], 0.0)
        self.assertIsNone(by_language["zh"]["recall_at_5"])

    def test_cosine_search_ranks_vectors_with_card_scope(self):
        terms = [
            {"id": "a", "card_id": "x"},
            {"id": "b", "card_id": "x"},
            {"id": "c", "card_id": "y"},
        ]
        vectors = {"a": [1.0, 0.0], "b": [0.0, 1.0], "c": [1.0, 0.0]}
        result = evaluation.semantic_search([1.0, 0.0], terms[:2], vectors, 5)
        self.assertEqual(result, ["a", "b"])
        with self.assertRaises(ValueError):
            evaluation.semantic_search([1.0, 0.0, 0.0], terms[:2], vectors, 5)

    def test_embedding_response_must_have_one_valid_vector_per_input(self):
        payload = {"data": [{"index": 1, "embedding": [0.0, 1.0]},
                            {"index": 0, "embedding": [1.0, 0.0]}]}
        self.assertEqual(
            evaluation.parse_embeddings(json.dumps(payload).encode(), 2),
            [[1.0, 0.0], [0.0, 1.0]],
        )
        with self.assertRaises(ValueError):
            evaluation.parse_embeddings(
                json.dumps({"data": [{"index": 0, "embedding": [1.0]}]}).encode(), 2
            )

    def test_semantic_arm_uses_explicit_workers_ai_request(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self):
                return json.dumps({
                    "data": [{"index": 0, "embedding": [1.0, 0.0]}]
                }).encode()

        with patch.object(evaluation.urllib.request, "urlopen", return_value=Response()) as send:
            result = evaluation.embed(["test"], "account-123", "secret-token")
        request = send.call_args.args[0]
        self.assertEqual(result, [[1.0, 0.0]])
        self.assertEqual(
            request.full_url,
            "https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/embeddings",
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        self.assertEqual(json.loads(request.data)["model"], evaluation.MODEL)

    def test_ollama_response_needs_one_valid_vector_per_input(self):
        payload = {"model": evaluation.OLLAMA_MODEL,
                   "embeddings": [[1.0, 0.0], [0.0, 1.0]]}
        self.assertEqual(
            evaluation.parse_ollama_embeddings(json.dumps(payload).encode(), 2),
            [[1.0, 0.0], [0.0, 1.0]],
        )
        with self.assertRaises(ValueError):
            evaluation.parse_ollama_embeddings(
                json.dumps({"embeddings": [[1.0]]}).encode(), 2
            )
        with self.assertRaises(ValueError):
            evaluation.parse_ollama_embeddings(
                json.dumps({"embeddings": [[float("nan"), 1.0]]}).encode(), 1
            )
        with self.assertRaises(ValueError):
            evaluation.parse_ollama_embeddings(
                json.dumps({"embeddings": [[1.0], ["x"]]}).encode(), 2
            )
        with self.assertRaises(ValueError):
            evaluation.parse_ollama_embeddings(
                json.dumps({"embeddings": [[1.0], [1.0, 2.0]]}).encode(), 2
            )
        with self.assertRaises(ValueError):
            evaluation.parse_ollama_embeddings(
                json.dumps({"error": "model not found"}).encode(), 1
            )

    def test_ollama_arm_posts_batched_input_to_local_endpoint(self):
        sent = []

        def fake_urlopen(request, timeout=None):
            payload = json.loads(request.data)
            sent.append((request.full_url, payload["model"], payload["input"]))
            return FakeResponse(json.dumps({
                "embeddings": [[1.0, 0.0] for _ in payload["input"]]
            }).encode())

        texts = [f"text {index}" for index in range(17)]
        with patch.object(evaluation.urllib.request, "urlopen", fake_urlopen):
            vectors = evaluation.embed_ollama(texts)
        self.assertEqual(len(vectors), 17)
        self.assertEqual(vectors, [[1.0, 0.0]] * 17)
        self.assertEqual(
            sent,
            [("http://127.0.0.1:11434/api/embed", evaluation.OLLAMA_MODEL,
              texts[:16]),
             ("http://127.0.0.1:11434/api/embed", evaluation.OLLAMA_MODEL,
              texts[16:])],
        )

    def test_rerank_summary_reports_score_separation(self):
        cases = [
            {"id": "hit", "relevant_ids": ["a"]},
            {"id": "miss", "relevant_ids": []},
        ]
        ranked = {
            "hit": [
                {"term_id": "b", "rerank_score": 0.95},
                {"term_id": "a", "rerank_score": 0.70},
            ],
            "miss": [{"term_id": "c", "rerank_score": 0.40}],
        }
        summary = evaluation.summarize_rerank(cases, ranked)
        self.assertEqual(summary["positive_top1"]["max"], 0.95)
        self.assertEqual(summary["negative_top1"]["max"], 0.40)
        self.assertEqual(summary["positive_gold"]["min"], 0.70)
        self.assertAlmostEqual(summary["separation_margin"], 0.30)
        summary = evaluation.summarize_rerank(
            [{"id": "only-neg", "relevant_ids": []}],
            {"only-neg": [{"term_id": "c", "rerank_score": 0.5}]},
        )
        self.assertIsNone(summary["positive_top1"])
        self.assertNotIn("separation_margin", summary)

    def test_ollama_http_error_and_unreachable_server_fail_closed(self):
        with patch.object(
            evaluation.urllib.request, "urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Ollama not reachable"):
                evaluation.embed_ollama(["query"])

        http_error = urllib.error.HTTPError(
            "http://localhost:11434/api/embed", 404, "Not Found", None,
            io.BytesIO(b'{"error":"model not found"}'),
        )
        with patch.object(
            evaluation.urllib.request, "urlopen", side_effect=http_error
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 404"):
                evaluation.embed_ollama(["query"])


if __name__ == "__main__":
    unittest.main()
