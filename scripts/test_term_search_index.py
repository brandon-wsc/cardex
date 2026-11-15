import hashlib
import json
import unittest

import term_search_eval as evaluation
import term_search_index as indexer


class TermSearchIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.terms, _ = evaluation.load_terms(
            evaluation.ROOT / "seed/seed.sql"
        )

    def test_parse_d1_results_reads_wrangler_json_envelope(self):
        body = json.dumps(
            [
                {"results": [{"id": "a"}, {"id": "b"}], "success": True},
                {"results": [{"id": "c"}], "success": True},
            ]
        )
        self.assertEqual(
            [r["id"] for r in indexer.parse_d1_results(body)],
            ["a", "b", "c"],
        )

    def test_parse_d1_results_fails_closed_on_error_entry(self):
        body = json.dumps([{"success": False, "error": "no such table"}])
        with self.assertRaises(ValueError):
            indexer.parse_d1_results(body)

    def test_vector_record_is_pointer_only(self):
        term = self.terms[0]
        record = indexer.vector_record(term, [0.1, 0.2])
        self.assertEqual(record["id"], term["id"])
        self.assertEqual(record["values"], [0.1, 0.2])
        meta = record["metadata"]
        self.assertEqual(meta["card_id"], term["card_id"])
        self.assertEqual(meta["kind"], term["kind"])
        # No fact text ever enters the index — metadata is routing/debugging
        # context plus the diff hash.
        for value in meta.values():
            self.assertNotIn(term["text"], str(value))
        self.assertEqual(
            meta["embed_hash"],
            hashlib.sha256(
                evaluation.term_text(term).encode()
            ).hexdigest(),
        )

    def test_vector_record_omits_null_dates_from_metadata(self):
        term = dict(self.terms[0], effective_from=None, effective_to=None)
        meta = indexer.vector_record(term, [0.1])["metadata"]
        self.assertNotIn("effective_from", meta)
        self.assertNotIn("effective_to", meta)

    def test_parse_vector_ids_accepts_shapes_wrangler_emits(self):
        self.assertEqual(
            indexer.parse_vector_ids('["a","b"]'), ["a", "b"]
        )
        self.assertEqual(
            indexer.parse_vector_ids('[{"id":"a"},{"id":"b"}]'), ["a", "b"]
        )
        self.assertEqual(
            indexer.parse_vector_ids('{"id":"a"}\n{"id":"b"}'), ["a", "b"]
        )
        self.assertEqual(indexer.parse_vector_ids("a\nb\n"), ["a", "b"])
        self.assertEqual(indexer.parse_vector_ids(""), [])

    def test_stale_ids_lists_indexed_ids_missing_from_terms(self):
        live = {t["id"] for t in self.terms}
        stale = indexer.stale_ids(
            [*sorted(live)[:2], "term_ghost", "term_deleted"], self.terms
        )
        self.assertEqual(stale, ["term_deleted", "term_ghost"])
        self.assertEqual(indexer.stale_ids(sorted(live), self.terms), [])


if __name__ == "__main__":
    unittest.main()
