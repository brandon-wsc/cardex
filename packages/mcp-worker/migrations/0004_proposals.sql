-- Maintenance proposals (ADR 0002). The maintenance agent inserts pending
-- rows through /maintainer; the owner approves or rejects in the portal.
-- patches is a JSON array of structured operations ({op, table, id, key?,
-- set?}) — never raw SQL, or the proposal channel becomes a write path.
CREATE TABLE proposals (
  id            TEXT PRIMARY KEY,
  proposed_by   TEXT NOT NULL,
  summary       TEXT NOT NULL,
  evidence_url  TEXT NOT NULL,
  excerpt       TEXT,
  patches       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved',
                  'rejected', 'applied')),
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT,
  decision_note TEXT
);

CREATE INDEX idx_proposals_status ON proposals (status, created_at);
