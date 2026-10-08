// Tally SMS into the seen-voting marks (issue #81): a tally SMS the
// coordinator pastes becomes a seen-voting mark for each of its roll serials,
// so a voter reported by SMS and a voter marked on a phone are one voter.
//
// - The message goes through the SMS inbox first (src/tally/smsInbox.js),
//   which checks it and keeps its serials on this phone. A rejected message
//   is returned as the inbox reported it and marks nothing.
// - Each serial of an accepted message is marked with recordSeen() of the
//   seen-voting store (src/tally/seenVotingStore.js) for the ward on screen,
//   in the name of the worker who sent the SMS. The store keys a mark by
//   ward and serial, so a voter already marked (on this phone, by a
//   teammate's synced mark or by an earlier SMS) keeps one mark. The new mark
//   is queued for the team like a tapped one, and the server keeps one entry
//   per mark id, so when the sender's phone reconnects and pushes its own
//   mark for that voter, the team count does not change.
// - Every serial of the message is marked, including those the inbox already
//   held, so pasting a message again finishes a merge that was cut short.
// - Serials that are not in the ward's roll are not marked: a tally SMS
//   carries no ward, and a message from another ward must not raise this
//   ward's count.
//
// Works offline: the inbox and the mark store are on the phone, and the
// sync engine sends the marks when there is a connection.

const ascending = (a, b) => a - b;

/**
 * @param {string} text the SMS as received
 * @param {{
 *   teamTag: string, wardId: string,
 *   inRoll?: (serial: number) => boolean,
 *   inbox: {applyTallySms: Function},
 *   marks: {recordSeen: Function},
 * }} opts inRoll says whether a serial is in the ward's roll (all are when omitted)
 * @returns {Promise<{ok: boolean, workerId: string|null, newSerials: number[],
 *   duplicateSerials: number[], outsideSerials: number[], reason?: string}>}
 *   newSerials were not marked before; duplicateSerials already were;
 *   outsideSerials are not in the ward's roll and were not marked
 * @throws when the inbox or the mark store cannot be read or written
 */
export async function applyTallySmsToMarks(text, { teamTag, wardId, inRoll = () => true, inbox, marks }) {
  const outcome = await inbox.applyTallySms(text, { teamTag });
  if (!outcome || !outcome.ok) {
    return { newSerials: [], duplicateSerials: [], outsideSerials: [], workerId: null, ...outcome, ok: false };
  }
  const serials = [...new Set([...outcome.newSerials, ...outcome.duplicateSerials])].sort(ascending);
  const newSerials = [];
  const duplicateSerials = [];
  const outsideSerials = [];
  for (const serial of serials) {
    if (!inRoll(serial)) {
      outsideSerials.push(serial);
      continue;
    }
    const { added } = await marks.recordSeen(wardId, serial, outcome.workerId);
    (added ? newSerials : duplicateSerials).push(serial);
  }
  return { ok: true, workerId: outcome.workerId, newSerials, duplicateSerials, outsideSerials };
}
