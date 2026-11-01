-- Maintenance-surface fixtures (ADR 0002): one quarantined report and one
-- pending proposal so /maintainer and /admin have something to show.
INSERT INTO reports (id, target_kind, target_id, field, claimed_value,
                     evidence_url, note, reported_at) VALUES
  ('rpt_seed_001', 'term', 'term_dbs_quota', 'quota_n', '15000',
   'https://example.invalid/cardex-seed/dbs-eminent-terms',
   'Illustrative: promo page shows a higher quota now.',
   '2026-10-31T16:44:00Z');

INSERT INTO proposals (id, proposed_by, summary, evidence_url, excerpt,
                       patches, status, created_at) VALUES
  ('prop_seed_001', 'grokbot',
   'Illustrative: DBS dining promo quota raised 10,000 to 15,000',
   'https://example.invalid/cardex-seed/dbs-eminent-terms',
   'Illustrative excerpt: the first 15,000 registered cardholders.',
   '[{"op":"update","table":"terms","id":"term_dbs_quota","set":{"quota_n":15000,"text":"Illustrative promo limited to the first 15,000 registrants.","last_verified_at":"2026-11-01"}}]',
   'pending', '2026-10-31T22:03:00Z');
