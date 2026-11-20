-- Rebuilds terms because SQLite cannot ALTER a CHECK constraint.
-- rate_terms and term_merchants FK-reference terms(id), and D1 runs with
-- foreign_keys ON: DROP TABLE's implicit DELETE would violate them on a
-- seeded database (0002/0003 got away with it only because terms was empty
-- at migrate time). The child rows are offloaded first and restored after
-- the rename, so no statement ever runs with a pending violation.

CREATE TABLE _rebuild_rate_terms AS SELECT rate_id, term_id FROM rate_terms;
CREATE TABLE _rebuild_term_merchants AS SELECT term_id, merchant FROM term_merchants;
DELETE FROM rate_terms;
DELETE FROM term_merchants;

CREATE TABLE terms_new (
  id               TEXT PRIMARY KEY,
  card_id          TEXT NOT NULL REFERENCES cards (id),
  kind             TEXT NOT NULL CHECK (kind IN ('cap', 'exclusion', 'fx_fee',
                    'min_spend', 'registration_required', 'channel', 'mcc',
                    'quota', 'merchant_list', 'geo', 'targeted', 'eligibility',
                    'settlement')),
  text             TEXT NOT NULL,
  source_url       TEXT,
  last_verified_at TEXT,
  effective_from   TEXT,
  effective_to     TEXT,
  cap_hkd          REAL,
  threshold_hkd    REAL,
  quota_n          INTEGER,
  register_by      TEXT,
  post_within_days INTEGER,
  anchor           TEXT,
  anchor_days      INTEGER,
  period           TEXT,
  exclusion_key    TEXT,
  ccy_scope        TEXT CHECK (ccy_scope IN ('non_hkd', 'hkd_outside_hk'))
);

INSERT INTO terms_new (id, card_id, kind, text, source_url, last_verified_at,
                       effective_from, effective_to, cap_hkd, threshold_hkd,
                       quota_n, register_by, post_within_days, anchor,
                       anchor_days, period, exclusion_key)
  SELECT id, card_id, kind, text, source_url, last_verified_at,
         effective_from, effective_to, cap_hkd, threshold_hkd,
         quota_n, register_by, post_within_days, anchor,
         anchor_days, period, exclusion_key
  FROM terms;

DROP TABLE terms;
ALTER TABLE terms_new RENAME TO terms;
CREATE INDEX idx_terms_card ON terms (card_id);

INSERT INTO rate_terms SELECT * FROM _rebuild_rate_terms;
INSERT INTO term_merchants SELECT * FROM _rebuild_term_merchants;
DROP TABLE _rebuild_rate_terms;
DROP TABLE _rebuild_term_merchants;
