-- Apply-time marks for the term-index reconcile (ADR 0015). Every approved
-- patch that can change a term's embedded document ("card_name kind text")
-- or remove the term lands a row here in the same D1 batch as the facts
-- write; the scheduled reconcile drains them — deleteByIds for terms gone
-- from D1, embed+upsert for anything whose stored embed_hash drifted.
-- Ops state, not facts: proposals cannot patch it (not in FACT_TABLES) and
-- it is never exported into seed/seed.sql.
-- queued_at holds `iso#uuid`: the reconcile drains by exact value, so every
-- mark needs a unique token — same-millisecond re-marks must stay distinct.
CREATE TABLE term_index_dirty (
  term_id   TEXT PRIMARY KEY,
  queued_at TEXT NOT NULL
);
