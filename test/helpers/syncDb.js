// The sync store as the suites that run functions/sync.js see it: an
// in-memory D1 (./memoryD1.js) with every sync migration applied, plus a
// read of what the server holds for one team.

import { createMemoryD1 } from './memoryD1.js';

export const SYNC_MIGRATIONS = ['migrations/0001_sync.sql', 'migrations/0002_sync_guards.sql'];

export const createSyncDb = () => createMemoryD1({ migrations: SYNC_MIGRATIONS });

// The team's stored records, as pull would return them plus seq and deviceId.
export function storedRecords(db, candidateId) {
  return db.sqlite.query(
    'SELECT seq, id, updated_at, ciphertext, iv, device_id FROM records WHERE candidate_id = ? ORDER BY seq', [candidateId],
  ).map(({ seq, id, updated_at: updatedAt, ciphertext, iv, device_id: deviceId }) => ({ id, updatedAt, ciphertext, iv, seq, deviceId }));
}
