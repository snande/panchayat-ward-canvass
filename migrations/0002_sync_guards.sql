-- Guards on the sync API (issue #180), applied after 0001_sync.sql.
--
-- join_failures counts wrong verifiers presented at POST /sync/join for one
-- candidate. functions/sync.js locks that candidate's joins until
-- locked_until (epoch milliseconds) once failures reaches its limit, then
-- starts counting again; a successful join clears the row. Only joins are
-- locked: devices that already hold a token keep pushing and pulling.
--
-- revoked_devices lists device tokens that must no longer push or pull. A
-- token names (candidate_id, device_id) and has no expiry, so this is how one
-- device is withdrawn without rotating SYNC_SECRET (which signs out every
-- team). The operator adds a row by hand, for example:
--   wrangler d1 execute <database> --remote --command \
--     "INSERT OR IGNORE INTO revoked_devices VALUES ('<candidateId>', '<deviceId>')"

CREATE TABLE IF NOT EXISTS join_failures (
  candidate_id TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revoked_devices (
  candidate_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (candidate_id, device_id)
);
