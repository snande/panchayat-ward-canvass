-- D1 schema for the sync store (issue #178), replacing the Workers KV layout
-- in functions/sync.js:
--   c/<candidateId>/r/<seq>    -> records
--   c/<candidateId>/seq        -> counters
--   c/<candidateId>/m/<id>     -> marks (the seen-voting mark index)
--   c/<candidateId>/verifier   -> verifiers
-- The primary keys give D1 the compare-and-set KV lacked: a (candidate_id, seq)
-- is appended once, and a mark id is stored once per team.
--
-- Payloads stay opaque: ciphertext and iv are stored as the base64url strings
-- the device sent. updated_at has no declared type on purpose: push accepts a
-- string or a number and pull must hand back exactly what was pushed, which a
-- TEXT or NUMERIC affinity would not (it would coerce one into the other).

CREATE TABLE IF NOT EXISTS records (
  candidate_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  updated_at NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (candidate_id, seq)
);

CREATE TABLE IF NOT EXISTS counters (
  candidate_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marks (
  candidate_id TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (candidate_id, id)
);

CREATE TABLE IF NOT EXISTS verifiers (
  candidate_id TEXT PRIMARY KEY,
  verifier TEXT NOT NULL
);
