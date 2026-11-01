-- Audit-driven term kinds and fields (docs/term-kind-audit.md, owner-approved).
-- Rebuilds terms because SQLite cannot ALTER a CHECK constraint; rates only
-- gains nullable columns so plain ALTER suffices. Adds term_merchants for
-- named merchant whitelists.

CREATE TABLE terms_new (
  id               TEXT PRIMARY KEY,
  card_id          TEXT NOT NULL REFERENCES cards (id),
  kind             TEXT NOT NULL CHECK (kind IN ('cap', 'exclusion', 'fx_fee',
                    'min_spend', 'registration_required', 'channel', 'mcc',
                    'quota', 'merchant_list', 'geo', 'targeted', 'eligibility')),
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
  exclusion_key    TEXT
);

INSERT INTO terms_new (id, card_id, kind, text, source_url, last_verified_at,
                       effective_from, effective_to, cap_hkd, period,
                       exclusion_key)
  SELECT id, card_id, kind, text, source_url, last_verified_at,
         effective_from, effective_to, cap_hkd, period, exclusion_key
  FROM terms;

DROP TABLE terms;
ALTER TABLE terms_new RENAME TO terms;
CREATE INDEX idx_terms_card ON terms (card_id);

-- Named merchant whitelist for merchant_list terms. Members are the literal
-- names an issuer publishes (Sushiro, TamJai, ...), not MCC codes.
CREATE TABLE term_merchants (
  term_id  TEXT NOT NULL REFERENCES terms (id),
  merchant TEXT NOT NULL,
  PRIMARY KEY (term_id, merchant)
);

-- Mutually exclusive rate buckets on one card (MMPOWER precedence, Mox
-- "highest applicable rate only"). The caller picks the best row per group.
ALTER TABLE rates ADD COLUMN exclusive_group TEXT;
ALTER TABLE rates ADD COLUMN priority INTEGER;
