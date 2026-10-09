// Voter search engine over every ward's roll: a Hindi or Latin query matches
// name, relative, house, serial and EPIC, with the matched field and ranges
// for highlighting; "3/145" jumps to ward 3, serial 145. Pure, in memory, no
// store reads; lookups come from the caller.
//
// Matching works on a Latin "skeleton" of each field:
//   - Devanagari is transliterated one character at a time, with the nukta
//     dropped, chandrabindu folded into anusvara (both "n"), vowel length
//     folded (ि/ी -> i, ु/ू -> u) and aspiration dropped (ख -> k, भ -> b).
//   - Latin is lowercased and folded the same way: w -> v, z -> j, q -> k,
//     f -> p, x -> ks, ee -> i, oo -> u, an "h" after a stop or sibilant is
//     dropped (sh -> s, bh -> b), and doubled letters collapse.
//   - Every "a" is dropped, inherent or written, short or long. This removes
//     the main mismatch between the two scripts: Hindi deletes many inherent
//     vowels (कमला is "kamla", not "kamala"), and Latin spellings vary
//     (Ram/Rama, Sita/Seeta).
// So "ramesh", "rame", "रमेश" and "रमे" all become "rmes" or a prefix of it.
// Each skeleton character records the span of source characters it came
// from, which turns a match in the skeleton back into ranges in the original
// text. Serial and EPIC are codes, so they are matched on their plain
// lowercase letters and digits instead.

import { normalize } from './hindiSearch.js';

const DEFAULT_LIMIT = 50;
const GRAM = 3;

// Fields matched through the phonetic skeleton, and code fields matched on
// their letters and digits. Field order is also the relevance tie-break
// (name before the other fields).
const PHONETIC_FIELDS = ['name', 'relative', 'house'];
const CODE_FIELDS = ['serial', 'epic'];
const FIELD_RANK = { name: 0, relative: 1, house: 2, serial: 3, epic: 4 };

// Tiers, best first.
const TIER_JUMP = -1;
const TIER_EXACT = 0;
const TIER_PREFIX = 1;
const TIER_WORD_PREFIX = 2;
const TIER_SUBSTRING = 3;

const SORTS = new Set(['relevance', 'serial', 'name', 'age']);

const DEVANAGARI = {
  // Independent vowels.
  'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u',
  'ऋ': 'ri', 'ॠ': 'ri', 'ऌ': 'li', 'ऍ': 'e', 'ऎ': 'e', 'ए': 'e',
  'ऐ': 'ai', 'ऑ': 'o', 'ऒ': 'o', 'ओ': 'o', 'औ': 'au',
  // Vowel signs.
  'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'ॄ': 'ri',
  'ॅ': 'e', 'ॆ': 'e', 'े': 'e', 'ै': 'ai', 'ॉ': 'o', 'ॊ': 'o', 'ो': 'o',
  'ौ': 'au',
  // Consonants, aspiration dropped.
  'क': 'k', 'ख': 'k', 'ग': 'g', 'घ': 'g', 'ङ': 'n',
  'च': 'c', 'छ': 'c', 'ज': 'j', 'झ': 'j', 'ञ': 'n',
  'ट': 't', 'ठ': 't', 'ड': 'd', 'ढ': 'd', 'ण': 'n',
  'त': 't', 'थ': 't', 'द': 'd', 'ध': 'd', 'न': 'n',
  'प': 'p', 'फ': 'p', 'ब': 'b', 'भ': 'b', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
  'श': 's', 'ष': 's', 'स': 's', 'ह': 'h',
  // Anusvara and chandrabindu fold together; visarga.
  'ं': 'n', 'ँ': 'n', 'ः': 'h',
  'ॐ': 'om',
};

const LATIN = { w: 'v', z: 'j', q: 'k', f: 'p', x: 'ks' };

// Marks that produce no skeleton letter but do not split a word: virama,
// nukta, avagraha, Vedic stress marks, ZWNJ/ZWJ and Latin diacritics.
const SILENT = /[़्ऽ॑-॔‌‍̀-ͯ]/;

// Marks that belong to the preceding letter. A highlight range is widened
// over them so it never splits a syllable.
const COMBINING = /[ऀ-ःऺ-ॏ॑-ॗॢॣ‌‍]/;

// Letters whose following "h" marks aspiration (kh, gh, ch, jh, th, dh, ph,
// bh) or a sibilant (sh), all folded to the bare letter.
const ASPIRABLE = new Set(['k', 'g', 'c', 'j', 't', 'd', 'p', 'b', 's']);

const DEVANAGARI_ZERO = 0x0966;

function devanagariDigit(ch) {
  const n = ch.charCodeAt(0) - DEVANAGARI_ZERO;
  return n >= 0 && n <= 9 ? String(n) : null;
}

/** Map Devanagari digits (U+0966-U+096F) to ASCII 0-9; other characters are kept. */
export function toAsciiDigits(str) {
  return str.replace(/[०-९]/g, (d) => devanagariDigit(d));
}

function isLetter(c) {
  return c >= 'a' && c <= 'z';
}

function widen(into, from) {
  if (from.s < into.s) into.s = from.s;
  if (from.e > into.e) into.e = from.e;
}

// The next character after index i that is not a silent mark.
function nextBase(text, i) {
  for (let j = i + 1; j < text.length; j += 1) {
    if (!SILENT.test(text[j])) return text[j];
  }
  return '';
}

// Transliterate text into skeleton tokens { c, s, e }: one Latin letter,
// digit or word separator (' '), with the source span [s, e) it came from.
function rawTokens(text) {
  const tokens = [];
  const push = (c, i) => tokens.push({ c, s: i, e: i + 1 });
  for (let i = 0; i < text.length; i += 1) {
    for (const d of text[i].normalize('NFD').toLowerCase()) {
      const dev = DEVANAGARI[d];
      if (dev) {
        // सिंह is spelt "singh": an anusvara before ह sounds as "ng".
        const out = (d === 'ं' || d === 'ँ') && nextBase(text, i) === 'ह' ? 'ng' : dev;
        for (const c of out) push(c, i);
      } else if (isLetter(d)) {
        for (const c of LATIN[d] || d) push(c, i);
      } else if (d >= '0' && d <= '9') {
        push(d, i);
      } else if (devanagariDigit(d) !== null) {
        push(devanagariDigit(d), i);
      } else if (!SILENT.test(d)) {
        push(' ', i);
      }
    }
  }
  return tokens;
}

// Fold raw tokens into the skeleton shared by both scripts. Merged or
// dropped tokens lend their source span to a neighbour in the same word, so
// a highlight still covers them.
function fold(tokens) {
  // Drop every "a". Its span joins the previous letter of the word, or the
  // next one when the word starts with it.
  let out = [];
  let lead = -1;
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (t.c === 'a') {
      if (last && last.c !== ' ') widen(last, t);
      else if (lead < 0) lead = t.s;
      continue;
    }
    if (t.c === ' ') {
      lead = -1;
      if (!last) continue;
      if (last.c === ' ') widen(last, t);
      else out.push({ ...t });
      continue;
    }
    const tok = { ...t };
    if (lead >= 0) {
      tok.s = Math.min(tok.s, lead);
      lead = -1;
    }
    out.push(tok);
  }

  // Long vowels spelt double (ee -> i, oo -> u); "h" after a stop or
  // sibilant (bh -> b, sh -> s).
  const res = [];
  for (const t of out) {
    const prev = res[res.length - 1];
    if (prev && prev.c === t.c && (t.c === 'e' || t.c === 'o')) {
      prev.c = t.c === 'e' ? 'i' : 'u';
      widen(prev, t);
    } else if (prev && t.c === 'h' && ASPIRABLE.has(prev.c)) {
      widen(prev, t);
    } else {
      res.push(t);
    }
  }

  // "m" before p/b is the anusvara sound (champa = चंपा); a word-final "y"
  // is the vowel "i" (Chaudhary = चौधरी). Then collapse doubled letters.
  out = [];
  for (let i = 0; i < res.length; i += 1) {
    const t = res[i];
    const next = res[i + 1];
    if (t.c === 'm' && next && (next.c === 'p' || next.c === 'b')) t.c = 'n';
    if (t.c === 'y' && (!next || next.c === ' ')) t.c = 'i';
    const prev = out[out.length - 1];
    if (prev && prev.c === t.c && isLetter(t.c)) widen(prev, t);
    else out.push(t);
  }
  while (out.length && out[out.length - 1].c === ' ') out.pop();
  return out;
}

function codeTokens(text) {
  const tokens = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const lower = ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch;
    const c = isLetter(lower) || (lower >= '0' && lower <= '9') ? lower : devanagariDigit(ch);
    if (c !== null) tokens.push({ c, s: i, e: i + 1 });
  }
  return tokens;
}

function keyOf(tokens) {
  return tokens.map((t) => t.c).join('');
}

function fieldRecord(field, kind, value) {
  if (value == null) return null;
  const text = String(value);
  const tokens = kind === 'p' ? fold(rawTokens(text)) : codeTokens(text);
  if (!tokens.length) return null;
  return Object.freeze({
    field,
    kind,
    text,
    key: keyOf(tokens),
    starts: tokens.map((t) => t.s),
    ends: tokens.map((t) => t.e),
  });
}

// One part of a ward:serial key: digits (Devanagari or ASCII) lose leading
// zeros; anything else is trimmed text.
function keyPart(value) {
  if (value == null) return '';
  const s = toAsciiDigits(String(value)).trim();
  return /^\d+$/.test(s) ? String(Number(s)) : s;
}

/**
 * The "ward:serial" key used for the jump and for every caller-supplied
 * filter lookup, e.g. "3:145" for { ward: 3, serial: 145 } or
 * { ward: '03', serial: '145' }.
 */
export function voterKey(entry) {
  if (!entry) return '';
  return `${keyPart(entry.ward)}:${keyPart(entry.serial)}`;
}

function addGrams(postings, kind, key, id) {
  for (let p = 0; p + GRAM <= key.length; p += 1) {
    const gram = kind + key.slice(p, p + GRAM);
    const list = postings.get(gram);
    if (!list) postings.set(gram, [id]);
    else if (list[list.length - 1] !== id) list.push(id);
  }
}

/** Build the index once per roll load; entries are referenced, never changed. */
export function buildSearchIndex(entries) {
  const records = [];
  const byKey = new Map();
  const postings = new Map();
  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    const id = records.length;
    const fields = [];
    for (const field of PHONETIC_FIELDS) {
      const rec = fieldRecord(field, 'p', entry[field]);
      if (rec) fields.push(rec);
    }
    for (const field of CODE_FIELDS) {
      const rec = fieldRecord(field, 'c', entry[field]);
      if (rec) fields.push(rec);
    }
    const key = voterKey(entry);
    records.push(
      Object.freeze({
        id,
        entry,
        key,
        nameSort: normalize(entry.name),
        fields: Object.freeze(fields),
      }),
    );
    if (!byKey.has(key)) byKey.set(key, id);
    for (const f of fields) addGrams(postings, f.kind, f.key, id);
  }
  return Object.freeze({ records: Object.freeze(records), byKey, postings });
}

/**
 * Parse a "ward/serial" jump query: "3/145" and " 3 / 145 " give
 * { ward: 3, serial: 145 }. Anything else gives null: "3/" (no serial yet),
 * "abc" and a bare "145". Devanagari digits are accepted too.
 */
export function parseWardSerial(query) {
  if (query == null) return null;
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(toAsciiDigits(String(query)));
  return m ? { ward: Number(m[1]), serial: Number(m[2]) } : null;
}

function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i += 1;
      j += 1;
    } else if (a[i] < b[j]) i += 1;
    else j += 1;
  }
  return out;
}

function gramCandidates(postings, kind, q) {
  const lists = [];
  for (let p = 0; p + GRAM <= q.length; p += 1) {
    const list = postings.get(kind + q.slice(p, p + GRAM));
    if (!list) return [];
    lists.push(list);
  }
  lists.sort((a, b) => a.length - b.length);
  let ids = lists[0];
  for (let k = 1; k < lists.length && ids.length; k += 1) ids = intersect(ids, lists[k]);
  return ids;
}

// Record ids that can match, or null when every record must be scanned (a
// query key shorter than one n-gram).
function candidateIds(index, qp, qc) {
  const found = new Set();
  for (const [kind, q] of [['p', qp], ['c', qc]]) {
    if (!q) continue;
    if (q.length < GRAM) return null;
    for (const id of gramCandidates(index.postings, kind, q)) found.add(id);
  }
  return [...found].sort((a, b) => a - b);
}

function rangeFor(rec, p, length) {
  const { text } = rec;
  let start = rec.starts[p];
  let end = rec.ends[p];
  for (let k = p; k < p + length; k += 1) {
    if (rec.starts[k] < start) start = rec.starts[k];
    if (rec.ends[k] > end) end = rec.ends[k];
  }
  while (start > 0 && COMBINING.test(text[start])) start -= 1;
  while (end < text.length && COMBINING.test(text[end])) end += 1;
  return { start, end };
}

function matchField(rec, q) {
  const first = rec.key.indexOf(q);
  if (first < 0) return null;
  let tier = TIER_SUBSTRING;
  if (rec.key === q) tier = TIER_EXACT;
  else if (first === 0) tier = TIER_PREFIX;
  else if (rec.key.includes(` ${q}`)) tier = TIER_WORD_PREFIX;

  const raw = [];
  for (let p = first; p >= 0; p = rec.key.indexOf(q, p + q.length)) {
    raw.push(rangeFor(rec, p, q.length));
  }
  raw.sort((a, b) => a.start - b.start);
  const ranges = [];
  for (const r of raw) {
    const last = ranges[ranges.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else ranges.push(r);
  }
  return { tier, ranges };
}

function bestMatch(rec, qp, qc) {
  let best = null;
  for (const f of rec.fields) {
    const q = f.kind === 'p' ? qp : qc;
    if (!q) continue;
    const m = matchField(f, q);
    if (!m) continue;
    if (
      !best ||
      m.tier < best.tier ||
      (m.tier === best.tier && FIELD_RANK[f.field] < FIELD_RANK[best.field])
    ) {
      best = { field: f.field, tier: m.tier, ranges: m.ranges };
    }
  }
  return best;
}

function sameValue(actual, wanted) {
  if (Array.isArray(wanted)) return wanted.some((w) => sameValue(actual, w));
  return keyPart(actual).toLowerCase() === keyPart(wanted).toLowerCase();
}

function isSet(value) {
  return value !== undefined && value !== null && value !== '';
}

function lookupValue(lookup, key, entry) {
  if (typeof lookup === 'function') return lookup(key, entry);
  if (lookup instanceof Map) return lookup.get(key);
  if (lookup instanceof Set) return lookup.has(key);
  if (lookup && typeof lookup === 'object') {
    return Object.prototype.hasOwnProperty.call(lookup, key) ? lookup[key] : undefined;
  }
  return undefined;
}

function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Set) return value.size > 0;
  return Boolean(value);
}

function holds(value, wanted) {
  if (Array.isArray(value)) return value.includes(wanted);
  if (value instanceof Set) return value.has(wanted);
  return value === wanted;
}

// A lookup filter is either the lookup itself (a function (key, entry), a
// Map, a Set or a plain object keyed by "ward:serial"), which keeps voters
// with a present value, or { lookup, value }, which keeps voters whose
// looked-up value is, or includes, value.
function lookupPasses(spec, key, entry) {
  const withValue =
    spec && typeof spec === 'object' && !(spec instanceof Map) && !(spec instanceof Set) &&
    Object.prototype.hasOwnProperty.call(spec, 'lookup');
  if (!withValue) return present(lookupValue(spec, key, entry));
  const got = lookupValue(spec.lookup, key, entry);
  return spec.value === undefined ? present(got) : holds(got, spec.value);
}

function passesFilters(rec, filters) {
  const { entry, key } = rec;
  if (isSet(filters.ward) && !sameValue(entry.ward, filters.ward)) return false;
  if (isSet(filters.booth) && !sameValue(entry.booth, filters.booth)) return false;
  if (isSet(filters.gender) && !sameValue(entry.gender, filters.gender)) return false;
  if (isSet(filters.ageMin) || isSet(filters.ageMax)) {
    const age = Number(entry.age);
    if (entry.age == null || entry.age === '' || !Number.isFinite(age)) return false;
    if (isSet(filters.ageMin) && age < Number(filters.ageMin)) return false;
    if (isSet(filters.ageMax) && age > Number(filters.ageMax)) return false;
  }
  if (filters.tag && !lookupPasses(filters.tag, key, entry)) return false;
  if (filters.visit && !lookupPasses(filters.visit, key, entry)) return false;
  if (filters.hasNumber && !lookupPasses(filters.hasNumber, key, entry)) return false;
  // notCalled's lookup says who has been called; those voters are dropped.
  if (filters.notCalled && lookupPasses(filters.notCalled, key, entry)) return false;
  return true;
}

function compareParts(a, b) {
  const x = keyPart(a);
  const y = keyPart(b);
  const nx = /^\d+$/.test(x) ? Number(x) : NaN;
  const ny = /^\d+$/.test(y) ? Number(y) : NaN;
  if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
  if (!Number.isNaN(nx)) return -1;
  if (!Number.isNaN(ny)) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

// Comparators take matches { rec, field, ranges, tier }.
function byWardSerial(a, b) {
  const x = a.rec.entry;
  const y = b.rec.entry;
  return compareParts(x.ward, y.ward) || compareParts(x.serial, y.serial);
}

let collator = null;
function compareNames(a, b) {
  if (!collator) collator = new Intl.Collator('hi');
  return collator.compare(a, b);
}

function ageOf(entry) {
  const n = Number(entry.age);
  return entry.age == null || entry.age === '' || !Number.isFinite(n) ? Infinity : n;
}

function fieldRank(field) {
  return field ? FIELD_RANK[field] : 0;
}

const COMPARATORS = {
  relevance: (a, b) =>
    a.tier - b.tier || fieldRank(a.field) - fieldRank(b.field) || byWardSerial(a, b),
  serial: byWardSerial,
  name: (a, b) => compareNames(a.rec.nameSort, b.rec.nameSort) || byWardSerial(a, b),
  age: (a, b) => {
    const x = ageOf(a.rec.entry);
    const y = ageOf(b.rec.entry);
    return (x === y ? 0 : x < y ? -1 : 1) || byWardSerial(a, b);
  },
};

function parseLimit(limit) {
  const n = Number(limit);
  return limit !== undefined && limit !== null && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
}

function toResult({ rec, field, ranges, tier }) {
  const jump = tier === TIER_JUMP;
  return {
    entry: rec.entry,
    key: rec.key,
    field,
    ranges,
    tier,
    exact: jump || (field !== null && tier === TIER_EXACT),
    jump,
  };
}

/**
 * Up to options.limit (50) results { entry, key, field, ranges, tier, exact,
 * jump }; tier -1 is a ward/serial jump (always first), then 0 exact, 1
 * prefix, 2 word prefix, 3 substring. options.filters: ward, booth, gender
 * (value or list), ageMin/ageMax (inclusive), tag/visit/hasNumber (lookups
 * keyed by voterKey, or { lookup, value }), notCalled (drops who it reports).
 * options.sort: relevance, serial, name or age. An empty query lists all.
 */
export function searchVoters(index, query, options = {}) {
  if (!index || !index.records) return [];
  const opts = options || {};
  const filters = opts.filters || {};
  const limit = parseLimit(opts.limit);
  const compare = COMPARATORS[SORTS.has(opts.sort) ? opts.sort : 'relevance'];
  const { records } = index;

  let head = null;
  const jump = parseWardSerial(query);
  if (jump) {
    const id = index.byKey.get(`${jump.ward}:${jump.serial}`);
    if (id !== undefined && passesFilters(records[id], filters)) {
      const rec = records[id];
      const end = String(rec.entry.serial).length;
      head = { rec, field: 'serial', ranges: [{ start: 0, end }], tier: TIER_JUMP };
    }
  }

  const text = normalize(query);
  const matches = [];
  if (!text) {
    for (const rec of records) {
      if (passesFilters(rec, filters)) {
        matches.push({ rec, field: null, ranges: [], tier: TIER_EXACT });
      }
    }
  } else {
    const qp = keyOf(fold(rawTokens(text)));
    const qc = keyOf(codeTokens(text));
    if (qp || qc) {
      const ids = candidateIds(index, qp, qc);
      const pool = ids ? ids.map((id) => records[id]) : records;
      for (const rec of pool) {
        if ((head && rec === head.rec) || !passesFilters(rec, filters)) continue;
        const best = bestMatch(rec, qp, qc);
        if (best) matches.push({ rec, ...best });
      }
    }
  }

  matches.sort(compare);
  if (head) matches.unshift(head);
  return matches.slice(0, limit).map(toResult);
}
