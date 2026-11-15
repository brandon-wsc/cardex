-- Card-level fee facts (ADR 0012). A fee is a record on the card, not a
-- condition on a rate, so it lives beside terms rather than inside them.
-- source_url cites the fee (issuer KFS/tariff); waiver_source_url cites the
-- waiver claim — community posts are acceptable citations for practice.
CREATE TABLE card_fees (
  id                TEXT PRIMARY KEY,
  card_id           TEXT NOT NULL REFERENCES cards (id),
  kind              TEXT NOT NULL CHECK (kind IN ('annual')),
  fee_hkd           REAL CHECK (fee_hkd IS NULL OR fee_hkd >= 0),
  waiver_policy     TEXT NOT NULL CHECK (waiver_policy IN
                    ('not_applicable', 'first_year', 'spend_threshold',
                     'conditional', 'on_request', 'none_known', 'unknown')),
  waiver_source_url TEXT,
  text              TEXT NOT NULL,
  source_url        TEXT,
  last_verified_at  TEXT,
  effective_from    TEXT,
  effective_to      TEXT,
  CHECK (NOT (waiver_policy = 'not_applicable' AND fee_hkd <> 0)),
  CHECK (NOT (waiver_policy = 'not_applicable' AND fee_hkd IS NULL)),
  CHECK (NOT (fee_hkd = 0 AND waiver_policy <> 'not_applicable'))
);

CREATE INDEX idx_card_fees_card ON card_fees (card_id);
