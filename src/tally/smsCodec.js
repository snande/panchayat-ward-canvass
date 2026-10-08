// SMS tally codec (issue #84): packs a worker's "seen voting" roll serials
// into plain SMS messages that reach the team number with mobile data off.
//
// Each message is `PT1 <teamTag> <workerId> <serials> <checksum>`:
//   serials   base36 roll serial numbers joined by '.', ascending, no repeats
//   checksum  first 4 hex digits of SHA-256 over everything before it
// Every message is at most 160 characters of plain ASCII (GSM-7 safe) and
// stands alone, so any one message can be applied on its own. Only roll
// serials are carried: no names, phone numbers or EPIC numbers.
//
// The decoder checks the teamTag, so one candidate's tally cannot be applied
// by another candidate's installation.

import { sha256Hex } from '../decoder/sha256.js';

export const SMS_PREFIX = 'PT1';
export const SMS_MAX_CHARS = 160;
const CHECKSUM_CHARS = 4;
const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const SERIAL_RE = /^[0-9a-z]+$/;

const checksum = (body) => sha256Hex(body).slice(0, CHECKSUM_CHARS);
const TEAM_TAG_CHARS = 16;

/**
 * The teamTag a team's messages carry: its candidate code when that fits an
 * SMS id (1-16 of A-Z a-z 0-9 _ -), otherwise the first 16 hex digits of the
 * code's SHA-256, so every phone of one team derives the same tag.
 * @param {string} candidateId the team's candidate code (src/sync/teamAuth.js)
 * @returns {string} '' when there is no candidate code
 */
export function teamTagFor(candidateId) {
  const id = typeof candidateId === 'string' ? candidateId.trim() : '';
  if (!id) return '';
  return ID_RE.test(id) ? id : sha256Hex(id).slice(0, TEAM_TAG_CHARS);
}

function seal(header, tokens) {
  const body = `${header} ${tokens.join('.')}`;
  return `${body} ${checksum(body)}`;
}

/**
 * @param {{teamTag: string, workerId: string, serials: Iterable<number>}} tally
 * @returns {string[]} the messages; empty when there are no serials
 */
export function encodeTallySms({ teamTag, workerId, serials }) {
  if (!ID_RE.test(String(teamTag ?? ''))) throw new Error('encodeTallySms: invalid teamTag');
  if (!ID_RE.test(String(workerId ?? ''))) throw new Error('encodeTallySms: invalid workerId');
  const unique = new Set();
  for (const serial of serials || []) {
    if (!Number.isSafeInteger(serial) || serial < 1) throw new Error(`encodeTallySms: invalid serial ${serial}`);
    unique.add(serial);
  }
  const tokens = [...unique].sort((a, b) => a - b).map((n) => n.toString(36));

  const header = `${SMS_PREFIX} ${teamTag} ${workerId}`;
  // Fixed cost of a message: header, two spaces and the checksum.
  const room = SMS_MAX_CHARS - header.length - 2 - CHECKSUM_CHARS;
  const messages = [];
  let part = [];
  let used = 0;
  for (const token of tokens) {
    if (token.length > room) throw new Error('encodeTallySms: header leaves no room for a serial');
    const cost = part.length ? token.length + 1 : token.length;
    if (used + cost > room) {
      messages.push(seal(header, part));
      part = [];
      used = 0;
    }
    used += part.length ? token.length + 1 : token.length;
    part.push(token);
  }
  if (part.length) messages.push(seal(header, part));
  return messages;
}

/**
 * @param {string} text one SMS as received (whitespace and line breaks allowed)
 * @param {string} expectedTeamTag this installation's teamTag
 * @returns {{ok: true, workerId: string, serials: number[]} | {ok: false, reason: string}}
 */
export function decodeTallySms(text, expectedTeamTag) {
  const tokens = String(text ?? '').trim().split(/\s+/);
  if (tokens[0] !== SMS_PREFIX) return { ok: false, reason: 'prefix' };
  if (tokens.length !== 5) return { ok: false, reason: 'format' };
  const [, teamTag, workerId, list, sum] = tokens;
  if (!ID_RE.test(teamTag) || !ID_RE.test(workerId)) return { ok: false, reason: 'format' };
  const parts = list.toLowerCase().split('.');
  if (!parts.every((p) => SERIAL_RE.test(p))) return { ok: false, reason: 'format' };
  if (sum.toLowerCase() !== checksum(`${SMS_PREFIX} ${teamTag} ${workerId} ${list}`)) {
    return { ok: false, reason: 'checksum' };
  }
  if (teamTag !== expectedTeamTag) return { ok: false, reason: 'team' };
  const serials = parts.map((p) => parseInt(p, 36));
  if (!serials.every((n) => Number.isSafeInteger(n) && n >= 1)) return { ok: false, reason: 'format' };
  return { ok: true, workerId, serials };
}
