// Pure Hindi (Devanagari) name normalisation, matching and ranking.
//
// The index lives in memory only: this module performs no I/O of any kind,
// so it stays offline-safe and never persists voter data.

const DEFAULT_LIMIT = 50;

const NUKTA = /़/g;
const JOINERS = /[‌‍]/g;
const CHANDRABINDU = /ँ/g;
const WHITESPACE = /\s+/g;

// Tiers, lowest ranks first.
const TIER_EXACT = 0;
const TIER_PREFIX = 1;
const TIER_WORD_PREFIX = 2;
const TIER_SUBSTRING = 3;

/**
 * Normalise a name or query so both compare identically:
 * Unicode NFC, ZWJ/ZWNJ removed, nukta removed, chandrabindu mapped to
 * anusvara, whitespace trimmed and collapsed.
 *
 * NFD is applied first so precomposed nukta letters (e.g. U+095B ज़, which
 * NFC keeps decomposed, and U+0929 ऩ, which NFC keeps composed) are split
 * into base + U+093C before the nukta is stripped.
 */
export function normalize(str) {
  if (str == null) return '';
  return String(str)
    .normalize('NFD')
    .replace(JOINERS, '')
    .replace(NUKTA, '')
    .replace(CHANDRABINDU, 'ं')
    .normalize('NFC')
    .replace(WHITESPACE, ' ')
    .trim();
}

/**
 * Build an in-memory search index over voters
 * ({ id, serial, name, relativeName, houseNo }).
 */
export function buildIndex(voters) {
  const entries = [];
  for (const voter of voters || []) {
    if (!voter || voter.name == null) continue;
    const norm = normalize(voter.name);
    if (!norm) continue;
    entries.push(Object.freeze({ voter, norm, words: norm.split(' ') }));
  }
  return Object.freeze(entries);
}

function serialKey(voter) {
  const n = Number(voter.serial);
  return Number.isFinite(n) ? n : Infinity;
}

function tierFor(entry, q) {
  const { norm, words } = entry;
  if (norm === q) return TIER_EXACT;
  if (norm.startsWith(q)) return TIER_PREFIX;
  if (words.some((w) => w.startsWith(q))) return TIER_WORD_PREFIX;
  if (norm.includes(q)) return TIER_SUBSTRING;
  return -1;
}

/**
 * Return voters whose normalised name contains the normalised query, ranked
 * exact match, name prefix, word prefix, then other substring; ties broken
 * by ascending serial. options.limit (default 50) caps the result length.
 */
export function search(index, query, options = {}) {
  const q = normalize(query);
  if (!q || !index) return [];

  const rawLimit = Number(options && options.limit);
  const limit =
    options && options.limit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : DEFAULT_LIMIT;

  const matches = [];
  for (const entry of index) {
    const tier = tierFor(entry, q);
    if (tier < 0) continue;
    matches.push({ tier, serial: serialKey(entry.voter), voter: entry.voter });
  }

  matches.sort(
    (a, b) => a.tier - b.tier || (a.serial === b.serial ? 0 : a.serial - b.serial),
  );
  return matches.slice(0, limit).map((m) => m.voter);
}
