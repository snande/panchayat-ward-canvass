// Rows of the call list: each consented voter with the worker who calls them.
//
// Pure: the consented voters (from the consent-capture store) and the
// assignments (from src/calls/assignmentStore.js) are passed in. Only
// consented voters are listed; an assignment for anyone else is ignored.

function lookup(assignments, serial) {
  if (!assignments) return undefined;
  if (assignments instanceof Map) return assignments.get(serial) ?? assignments.get(String(serial));
  return Object.hasOwn(assignments, serial) ? assignments[serial] : undefined;
}

/**
 * @param {{serial: number, name: string, phone: string}[]} consentedVoters
 * @param {Record<number, {workerId: string, workerName: string}> | Map} assignments serial -> assignee
 * @returns {{serial, name, phone, workerId: string | null, workerName: string | null}[]}
 *   one row per consented voter, in the given order
 */
export function buildCallList(consentedVoters, assignments) {
  if (!Array.isArray(consentedVoters)) throw new TypeError('consentedVoters must be an array');
  return consentedVoters.map(({ serial, name, phone }) => {
    const assigned = lookup(assignments, serial);
    return {
      serial,
      name,
      phone,
      workerId: assigned?.workerId ?? null,
      workerName: assigned?.workerName ?? null,
    };
  });
}
