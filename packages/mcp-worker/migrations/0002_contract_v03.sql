-- Contract deltas for PRD v0.3 (P1). Rebuilds rates/terms because SQLite
-- cannot ALTER a CHECK constraint, and adds reports + meta tables.

CREATE TABLE rates_new (
  id               TEXT PRIMARY KEY,
  card_id          TEXT NOT NULL REFERENCES cards (id),
  kind             TEXT NOT NULL CHECK (kind IN ('rebate_percent', 'points')),
  value            REAL NOT NULL,
  unit             TEXT NOT NULL,
  source_url       TEXT,
  last_verified_at TEXT,
  effective_from   TEXT,
  effective_to     TEXT
);

INSERT INTO rates_new (id, card_id, kind, value, unit)
  SELECT id, card_id,
    CASE kind WHEN 'points_per_hkd' THEN 'points' ELSE kind END,
    value,
    CASE kind WHEN 'points_per_hkd' THEN 'points_per_hkd' ELSE 'percent' END
  FROM rates;

DROP TABLE rates;
ALTER TABLE rates_new RENAME TO rates;
CREATE INDEX idx_rates_card ON rates (card_id);

CREATE TABLE terms_new (
  id               TEXT PRIMARY KEY,
  card_id          TEXT NOT NULL REFERENCES cards (id),
  kind             TEXT NOT NULL CHECK (kind IN ('cap', 'exclusion', 'fx_fee',
                    'min_spend', 'registration_required', 'channel', 'mcc')),
  text             TEXT NOT NULL,
  source_url       TEXT,
  last_verified_at TEXT,
  effective_from   TEXT,
  effective_to     TEXT,
  cap_hkd          REAL,
  period           TEXT,
  exclusion_key    TEXT
);

INSERT INTO terms_new (id, card_id, kind, text, source_url, effective_from,
                       effective_to, cap_hkd, period, exclusion_key)
  SELECT id, card_id, kind, text, source_url, effective_from,
         effective_to, cap_hkd, period, exclusion_key
  FROM terms;

DROP TABLE terms;
ALTER TABLE terms_new RENAME TO terms;
CREATE INDEX idx_terms_card ON terms (card_id);

-- Quarantine for report_issue: never read by query tools, triaged by the
-- maintenance loop (ADR 0001).
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('card', 'rate', 'term')),
  target_id     TEXT NOT NULL,
  field         TEXT NOT NULL,
  claimed_value TEXT NOT NULL,
  evidence_url  TEXT,
  note          TEXT,
  reported_at   TEXT NOT NULL
);

-- Single-row key/value store; seed writes seed_as_of here.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
