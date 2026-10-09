// Pure helpers for scripts/search-perf.mjs: the seeded synthetic roll, the
// fixed query mix, nearest-rank percentiles and the markdown report. No
// browser, file or network access, so the unit tests (and the sandbox) can
// import this module without puppeteer installed.

// mulberry32: a small, fast, seedable PRNG returning floats in [0, 1).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// Each name carries a common Latin spelling, so Latin queries hit real rows.
const MALE = [
  ['रमेश', 'ramesh'], ['सुरेश', 'suresh'], ['महेश', 'mahesh'], ['मोहन', 'mohan'],
  ['राम सहाय', 'ram sahay'], ['गोविन्द', 'govind'], ['जगदीश', 'jagdish'], ['मांगीलाल', 'mangilal'],
  ['राजेन्द्र', 'rajendra'], ['विनोद', 'vinod'], ['दिनेश', 'dinesh'], ['मुकेश', 'mukesh'],
  ['कैलाश', 'kailash'], ['हरि नारायण', 'hari narayan'], ['श्याम', 'shyam'], ['गिर्राज', 'girraj'],
  ['प्रकाश', 'prakash'], ['सत्यनारायण', 'satyanarayan'], ['भागचन्द', 'bhagchand'], ['पांचू राम', 'panchu ram'],
];
const FEMALE = [
  ['सीता', 'sita'], ['गीता', 'geeta'], ['कमला', 'kamla'], ['ममता', 'mamta'],
  ['गायत्री', 'gayatri'], ['किशना देवी', 'kishna devi'], ['चांद देवी', 'chand devi'], ['सुनीता', 'sunita'],
  ['पूजा', 'pooja'], ['शान्ति', 'shanti'], ['लक्ष्मी', 'laxmi'], ['मीना', 'meena'],
  ['सरोज', 'saroj'], ['रेखा', 'rekha'], ['संतोष', 'santosh'], ['भगवती', 'bhagwati'],
];
const SURNAMES = [
  ['शर्मा', 'sharma'], ['जांगिड़', 'jangid'], ['बैरवा', 'bairwa'], ['मीणा', 'meena'],
  ['गुर्जर', 'gurjar'], ['सैनी', 'saini'], ['यादव', 'yadav'], ['जाट', 'jat'],
  ['कुमावत', 'kumawat'], ['प्रजापत', 'prajapat'], ['', ''], ['', ''],
];
const DEVA_DIGITS = '०१२३४५६७८९';
const toDeva = (s) => String(s).replace(/\d/g, (d) => DEVA_DIGITS[d]);

export const WARDS = 6;

/**
 * A deterministic synthetic roll of `size` entries spread over WARDS wards:
 * { ward, booth, serial, name, relative, age, gender, house, epic }, with
 * Devanagari names and relatives and house numbers written in ASCII or
 * Devanagari digits, sometimes with a sub-number or letter ("12/3", "७ए").
 * Serials restart at 1 in every ward. The same seed always gives the same roll.
 */
export function makeRoll(seed, size) {
  const rand = rng(seed);
  const perWard = Math.ceil(size / WARDS);
  const roll = [];
  for (let i = 0; i < size; i += 1) {
    const ward = Math.floor(i / perWard) + 1;
    const serial = (i % perWard) + 1;
    const female = rand() < 0.48;
    const [first] = pick(rand, female ? FEMALE : MALE);
    const [surname] = pick(rand, SURNAMES);
    const [relFirst] = pick(rand, MALE);
    const name = surname ? `${first} ${surname}` : first;
    const relative = surname && rand() < 0.7 ? `${relFirst} ${surname}` : relFirst;
    const houseNo = 1 + Math.floor(rand() * 400);
    const shape = rand();
    let house;
    if (shape < 0.45) house = String(houseNo);
    else if (shape < 0.75) house = toDeva(houseNo);
    else if (shape < 0.9) house = `${houseNo}/${1 + Math.floor(rand() * 9)}`;
    else house = `${toDeva(houseNo)}ए`;
    const epic = `RJ${String(ward).padStart(2, '0')}${String(100000 + Math.floor(rand() * 900000))}`;
    roll.push({
      ward,
      booth: ward * 10 + Math.floor(serial / 400) + 1,
      serial,
      name,
      relative,
      age: 18 + Math.floor(rand() * 70),
      gender: female ? 'महिला' : 'पुरूष',
      house,
      epic,
    });
  }
  return roll;
}

export const QUERY_KINDS = ['latin', 'devanagari', 'partial', 'house', 'serial', 'ward/serial'];

/**
 * The fixed query mix: `perKind` queries of each kind in QUERY_KINDS,
 * interleaved kind by kind so any leading warm-up slice covers every kind.
 * Returns [{ kind, q }]. House, serial and ward/serial queries are drawn from
 * `roll`, so they name rows that exist.
 */
export function makeQueries(roll, seed, perKind = 36) {
  const rand = rng(seed ^ 0x5eed);
  const names = [...MALE, ...FEMALE];
  const make = {
    latin: () => {
      const [, first] = pick(rand, names);
      const [, sur] = pick(rand, SURNAMES);
      return sur && rand() < 0.4 ? `${first} ${sur}` : first;
    },
    devanagari: () => {
      const [first] = pick(rand, names);
      const [sur] = pick(rand, SURNAMES);
      return sur && rand() < 0.4 ? `${first} ${sur}` : first;
    },
    partial: () => {
      const [deva, latin] = pick(rand, names);
      const src = rand() < 0.5 ? latin : deva;
      return src.slice(0, 2 + Math.floor(rand() * 2));
    },
    house: () => pick(rand, roll).house,
    serial: () => String(pick(rand, roll).serial),
    'ward/serial': () => {
      const e = pick(rand, roll);
      return rand() < 0.5 ? `${e.ward}/${e.serial}` : ` ${e.ward} / ${e.serial} `;
    },
  };
  const queries = [];
  for (let i = 0; i < perKind; i += 1) {
    for (const kind of QUERY_KINDS) queries.push({ kind, q: make[kind]() });
  }
  return queries;
}

/**
 * Nearest-rank percentile: the smallest sample with at least p% of the
 * samples at or below it. percentile([1..100], 95) is 95. Does not change
 * `samples`; returns NaN for an empty list.
 */
export function percentile(samples, p) {
  if (!samples || samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const ms = (v) => `${v.toFixed(2)} ms`;

/**
 * The markdown report. `byKind` maps a query kind to { count, p95 } for the
 * per-kind breakdown; `browser` names the Chrome build.
 */
export function renderReport(r) {
  const verdict = r.pass
    ? `**Pass: p95 ${ms(r.p95)} is under the ${r.threshold} ms budget.**`
    : `**Fail: p95 ${ms(r.p95)} is not under the ${r.threshold} ms budget.**`;
  const lines = [
    '# Voter search performance',
    '',
    `Engine: \`src/search/voterSearch.js\` (\`searchVoters\`, default options), loaded in headless ${r.browser}`,
    `with DevTools \`Emulation.setCPUThrottlingRate\` at ${r.throttle}x. Roll: deterministic synthetic roll of`,
    `${r.rollSize} voters over ${r.wards} wards (seed ${r.seed}); no downloaded data. Regenerate with`,
    '`node scripts/search-perf.mjs`.',
    '',
    verdict,
    '',
    '| measure | value |',
    '|---|---:|',
    `| roll size | ${r.rollSize} voters |`,
    `| CPU throttling rate | ${r.throttle}x |`,
    `| timed queries | ${r.queries} (after ${r.warmup} discarded warm-up queries) |`,
    `| p50 | ${ms(r.p50)} |`,
    `| p95 | ${ms(r.p95)} |`,
    `| max | ${ms(r.max)} |`,
    `| index build (once per roll load) | ${ms(r.buildMs)} |`,
    `| queries with no result | ${r.empty} |`,
    '',
    '## By query kind',
    '',
    '| kind | queries | p95 |',
    '|---|---:|---:|',
  ];
  for (const [kind, k] of Object.entries(r.byKind)) {
    lines.push(`| ${kind} | ${k.count} | ${ms(k.p95)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
