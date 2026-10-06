// Comparison and report rendering for scripts/benchmark.mjs, kept separate so
// the scoring rules are unit-tested (scripts/benchmark-compare.test.mjs).
//
// An expected entry matches when, for every key it has, the decoded entry
// with the same serial holds an equal value. Strings are compared after NFC
// normalisation on both sides: the decoder returns NFC, and
// fixtures/badli-ward1-expected.json spells ड़ with the precomposed U+095C,
// which NFC decomposes (U+0958-U+095F are composition exclusions). The two
// spellings are canonically equivalent; nothing else is relaxed, so a key the
// decoder leaves undefined never equals an expected null.

const norm = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);

/**
 * @param {object[]} decoded decodeRoll output (struck-off entries flagged `deleted`)
 * @param {object[]} expected ground truth, struck-off serials left out
 * @returns {{total: number, matched: object[], mismatches: object[], percent: number, deleted: number}}
 *   matched: [{got, want}]; mismatches: [{serial, page, field, decoded, expected}]
 */
export function compareEntries(decoded, expected) {
  const all = new Map(decoded.map((e) => [e.serial, e]));
  const live = new Map(decoded.filter((e) => !e.deleted).map((e) => [e.serial, e]));
  const sortedDecoded = [...decoded].sort((a, b) => a.serial - b.serial);
  // Page of an entry the decoder lost: where it put the serial (struck off),
  // else the page of the nearest decoded serial before it.
  const pageOf = (serial) => {
    if (all.has(serial)) return all.get(serial).page;
    let page;
    for (const e of sortedDecoded) {
      if (e.serial > serial) break;
      page = e.page;
    }
    return page ?? sortedDecoded[0]?.page;
  };

  const matched = [];
  const mismatches = [];
  for (const want of expected) {
    const got = live.get(want.serial);
    if (!got) {
      const struck = all.has(want.serial);
      mismatches.push({
        serial: want.serial,
        page: pageOf(want.serial),
        field: struck ? 'deleted' : '(entry not decoded)',
        decoded: struck ? true : undefined,
        expected: struck ? false : want.name,
      });
      continue;
    }
    const bad = Object.keys(want).filter((k) => norm(got[k]) !== norm(want[k]));
    if (!bad.length) matched.push({ got, want });
    for (const field of bad) mismatches.push({ serial: want.serial, page: got.page, field, decoded: got[field], expected: want[field] });
  }
  const expectedSerials = new Set(expected.map((e) => e.serial));
  for (const got of live.values()) {
    if (!expectedSerials.has(got.serial)) {
      mismatches.push({ serial: got.serial, page: got.page, field: '(entry not expected)', decoded: got.name, expected: undefined });
    }
  }
  mismatches.sort((a, b) => a.serial - b.serial);
  const total = expected.length;
  const percent = total ? Math.round((matched.length / total) * 10000) / 100 : 0;
  return { total, matched, mismatches, percent, deleted: decoded.filter((e) => e.deleted).length };
}

/**
 * Side-by-side sample for the demo: the first matched entry on every page,
 * topped up in roll order until there are at least `min`.
 */
export function sampleMatched(matched, min = 10) {
  const sample = [];
  const pages = new Set();
  for (const m of matched) if (!pages.has(m.got.page)) { pages.add(m.got.page); sample.push(m); }
  for (const m of matched) {
    if (sample.length >= min) break;
    if (!sample.includes(m)) sample.push(m);
  }
  return sample.sort((a, b) => a.got.serial - b.got.serial);
}

const cell = (v) => (v === undefined ? '(missing)' : JSON.stringify(v)).replace(/\|/g, '\\|');

/** The Markdown report. Deterministic: no timestamps, so CI can diff it. */
export function renderReport({ total, matched, mismatches, percent, deleted }, { fields, sampleMin = 10 } = {}) {
  const lines = [
    '# Badli ward 1 decoder benchmark',
    '',
    'Input: `fixtures/badli-ward1.pdf`. Ground truth: `fixtures/badli-ward1-expected.json`.',
    'Decoder: `src/decoder/decodeRoll.js` (glyph outlines matched to `src/decoder/master-glyph-table.json`;',
    'no OCR, no Kruti Dev table, no network). Regenerate with `node scripts/benchmark.mjs`.',
    '',
    `**Score: ${matched.length} of ${total} entries match exactly (${percent}%).**`,
    '',
    `An entry matches when every field (${fields.join(', ')}) is equal;`,
    'strings are compared NFC-normalised on both sides. The decoder also found',
    `${deleted} struck-off serials, which the expected file leaves out.`,
    '',
    '## Mismatched entries',
    '',
  ];
  if (mismatches.length) {
    const entries = new Set(mismatches.map((x) => x.serial)).size;
    lines.push(
      `${entries} entries differ (one row per differing field). Page is the PDF page number;`,
      'for an entry the decoder did not find, it is the page of the nearest decoded serial before it.',
      '',
      '| serial | page | field | decoded | expected |',
      '|---:|---:|---|---|---|',
    );
    for (const x of mismatches) lines.push(`| ${x.serial} | ${x.page ?? '-'} | ${x.field} | ${cell(x.decoded)} | ${cell(x.expected)} |`);
  } else {
    lines.push('None: all expected entries match, so there are no mismatched entries to list.');
  }
  lines.push(
    '',
    '## Side-by-side sample of matched entries',
    '',
    'Page is the PDF page number, for comparison with the rendered roll.',
    '',
    '| serial | PDF page | decoded name | expected name | decoded relative | expected relative |',
    '|---:|---:|---|---|---|---|',
  );
  for (const { got, want } of sampleMatched(matched, sampleMin)) {
    lines.push(`| ${got.serial} | ${got.page} | ${got.name} | ${want.name} | ${got.relative} | ${want.relative} |`);
  }
  lines.push('');
  return lines.join('\n');
}
