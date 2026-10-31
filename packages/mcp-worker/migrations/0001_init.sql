-- Cardex v1 schema. Query store for the MCP tools; seeded offline (ADR 0001).
-- Language per CONTEXT.md: card, issuer, rate, term, tag, alias.

CREATE TABLE cards (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  issuer  TEXT NOT NULL,
  network TEXT NOT NULL
);

CREATE TABLE tags (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind  TEXT NOT NULL CHECK (kind IN ('channel', 'category'))
);

CREATE TABLE rates (
  id      TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards (id),
  kind    TEXT NOT NULL CHECK (kind IN ('rebate_percent', 'points_per_hkd')),
  value   REAL NOT NULL
);

CREATE TABLE rate_tags (
  rate_id TEXT NOT NULL REFERENCES rates (id),
  tag_id  TEXT NOT NULL REFERENCES tags (id),
  PRIMARY KEY (rate_id, tag_id)
);

-- A term carries the human-readable condition plus where it was sourced from
-- and when it applies, so a caller can judge freshness.
CREATE TABLE terms (
  id             TEXT PRIMARY KEY,
  card_id        TEXT NOT NULL REFERENCES cards (id),
  kind           TEXT NOT NULL CHECK (kind IN ('cap', 'exclusion')),
  text           TEXT NOT NULL,
  source_url     TEXT,
  effective_from TEXT,
  effective_to   TEXT,
  cap_hkd        REAL,
  period         TEXT,
  exclusion_key  TEXT
);

CREATE TABLE rate_terms (
  rate_id TEXT NOT NULL REFERENCES rates (id),
  term_id TEXT NOT NULL REFERENCES terms (id),
  PRIMARY KEY (rate_id, term_id)
);

CREATE TABLE aliases (
  text TEXT PRIMARY KEY
);

CREATE TABLE alias_tags (
  alias_text TEXT NOT NULL REFERENCES aliases (text),
  tag_id     TEXT NOT NULL REFERENCES tags (id),
  PRIMARY KEY (alias_text, tag_id)
);

CREATE TABLE alias_cards (
  alias_text TEXT NOT NULL REFERENCES aliases (text),
  card_id    TEXT NOT NULL REFERENCES cards (id),
  PRIMARY KEY (alias_text, card_id)
);

CREATE INDEX idx_rates_card ON rates (card_id);
CREATE INDEX idx_rate_tags_tag ON rate_tags (tag_id);
CREATE INDEX idx_terms_card ON terms (card_id);
