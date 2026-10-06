import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  mapSubsetGlyphs, analyseSubsetGlyphs, canonicalOutline, outlineHash, loadMasterTable, roundHalfEven, SPACE_ENTRY,
} from './glyphMap.js';
import { sha256Hex } from './sha256.js';
import { embeddedFonts } from '../../scripts/pdf-fonts.mjs';

const pt = (x, y, on = true) => ({ x, y, on });
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fixturePdf = () => readFileSync(here('../../fixtures/badli-ward1.pdf'));
const committedTable = () => JSON.parse(readFileSync(here('./master-glyph-table.json'), 'utf8'));

// --- a tiny TrueType builder for synthetic fonts -------------------------

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [...u16(n >>> 16), ...u16(n & 0xffff)];

function simpleGlyph(contours) {
  const points = contours.flat();
  const bytes = [...u16(contours.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0)];
  let n = -1;
  for (const c of contours) { n += c.length; bytes.push(...u16(n)); }
  bytes.push(...u16(0), ...points.map((p) => (p.on === false ? 0 : 1)));
  let prev = 0;
  for (const p of points) { bytes.push(...u16((p.x - prev) & 0xffff)); prev = p.x; }
  prev = 0;
  for (const p of points) { bytes.push(...u16((p.y - prev) & 0xffff)); prev = p.y; }
  return bytes;
}

// parts: { gid, dx, dy, scale } or { gid, matchParent, matchChild }
function compositeGlyph(parts) {
  const bytes = [...u16(0xffff), ...u16(0), ...u16(0), ...u16(0), ...u16(0)];
  parts.forEach((part, i) => {
    const xy = part.matchParent === undefined;
    const flags = (i < parts.length - 1 ? 0x20 : 0) | 0x01 | (xy ? 0x02 : 0) | (part.scale ? 0x08 : 0);
    bytes.push(...u16(flags), ...u16(part.gid));
    bytes.push(...(xy ? [...u16(part.dx & 0xffff), ...u16(part.dy & 0xffff)] : [...u16(part.matchParent), ...u16(part.matchChild)]));
    if (part.scale) bytes.push(...u16(Math.round(part.scale * 16384)));
  });
  return bytes;
}

// options: sfnt (header tag), shortLoca, cmap ({code: gid}, format 0 / platform 1), order (table tags)
function buildFont(glyphs, { sfnt = 0x00010000, shortLoca = false, cmap, order = ['head', 'maxp', 'cmap', 'loca', 'glyf'] } = {}) {
  const padded = glyphs.map((g) => [...g, ...new Array((4 - (g.length % 4)) % 4).fill(0)]);
  const loca = [];
  let off = 0;
  for (const g of padded) { loca.push(...(shortLoca ? u16(off / 2) : u32(off))); off += g.length; }
  loca.push(...(shortLoca ? u16(off / 2) : u32(off)));
  const head = new Array(54).fill(0);
  head.splice(18, 2, ...u16(2048));
  head.splice(50, 2, ...u16(shortLoca ? 0 : 1));
  const maxp = [...u32(0x00010000), ...u16(glyphs.length)];
  const map = new Array(256).fill(0);
  for (const [code, gid] of Object.entries(cmap ?? {})) map[Number(code)] = gid;
  const cmapTable = [...u16(0), ...u16(1), ...u16(1), ...u16(0), ...u32(12), ...u16(0), ...u16(262), ...u16(0), ...map];
  const all = { head, maxp, cmap: cmapTable, loca, glyf: padded.flat() };
  const tables = order.filter((tag) => tag !== 'cmap' || cmap).map((tag) => [tag, all[tag]]);
  const out = [...u32(sfnt), ...u16(tables.length), ...u16(0), ...u16(0), ...u16(0)];
  let pos = 12 + tables.length * 16;
  for (const [tag, data] of tables) {
    out.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(pos), ...u32(data.length));
    pos += data.length;
  }
  for (const [, data] of tables) out.push(...data);
  return Uint8Array.from(out);
}

const square = (x0, y0, size = 100) => [pt(x0, y0), pt(x0, y0 + size), pt(x0 + size, y0 + size), pt(x0 + size, y0)];
const entryFor = (name, cp) => ({ gid: 99, name, kind: 'base', codepoints: [cp] });
const tableOf = (pairs) => ({ glyphs: Object.fromEntries(pairs.map(([contours, entry]) => [outlineHash(contours), entry])) });

// --- hashing -------------------------------------------------------------

test('sha256Hex matches the standard test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('roundHalfEven rounds halves to the even neighbour, like Python round()', () => {
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  assert.equal(roundHalfEven(-2.5), -2);
  assert.equal(roundHalfEven(-1.5), -2);
  assert.equal(roundHalfEven(0.5), 0);
  assert.equal(roundHalfEven(1.4), 1);
  assert.equal(roundHalfEven(-1.4), -1);
  assert.ok(Object.is(roundHalfEven(-0.5), 0), 'never returns -0');
  assert.equal(roundHalfEven(7), 7);
});

test('canonical outline: lines, rotated to the smallest on-curve point and closed', () => {
  const sq = [pt(100, 100), pt(0, 100), pt(0, 0), pt(100, 0)];
  assert.equal(canonicalOutline([sq]), 'M 0,0|L 100,0|L 100,100|L 0,100|L 0,0');
});

test('canonical outline: off-curve runs split at implied midpoints, truncated toward zero', () => {
  const curve = [pt(0, 0), pt(100, 0, false), pt(100, 100, false), pt(0, 100)];
  assert.equal(canonicalOutline([curve]), 'M 0,0|Q 100,0 100,50|Q 100,100 0,100|L 0,0');
  const odd = [pt(0, 0), pt(1, 1, false), pt(2, 1, false), pt(3, 0)];
  assert.equal(canonicalOutline([odd]), 'M 0,0|Q 1,1 1,1|Q 2,1 3,0|L 0,0');
  const negative = [pt(0, 0), pt(-1, -1, false), pt(-2, -1, false), pt(-3, 0)];
  assert.equal(canonicalOutline([negative]), 'M -3,0|L 0,0|Q -1,-1 -1,-1|Q -2,-1 -3,0');
});

test('canonical outline: a contour with no on-curve point starts at a synthetic midpoint', () => {
  const circle = [pt(0, 0, false), pt(100, 0, false), pt(100, 100, false), pt(0, 100, false)];
  assert.equal(
    canonicalOutline([circle]),
    'M 0,50|Q 0,0 50,0|Q 100,0 100,50|Q 100,100 50,100|Q 0,100 0,50',
  );
});

test('canonical outline: contours are sorted as strings and joined with ;', () => {
  const joined = canonicalOutline([square(50, 50, 10), square(5, 5, 10)]);
  assert.deepEqual(joined.split(';').map((s) => s.slice(0, 6)), ['M 5,5|', 'M 50,5']);
  assert.equal(canonicalOutline([square(5, 5, 10), square(50, 50, 10)]), joined);
});

test('an empty outline has the empty glyph string and no hash', () => {
  assert.equal(canonicalOutline([]), '');
  assert.equal(outlineHash([]), '');
  assert.deepEqual(SPACE_ENTRY.codepoints, [0x20]);
});

// --- golden values from the committed table (built by glyphtable.py) ---------

test('golden: canonical strings of real glyphs hash to the committed table keys built by glyphtable.py', () => {
  const table = committedTable().glyphs;
  const golden = [
    // curves, a closed contour that starts mid-run, implied midpoints
    ['19b19bac1b0d518c93f773666fa82ea59fcbaf343daf77be262f415f60bd862d', 'comma', [44],
      'M 172,-213|Q 284,-165 285,0|L 184,0|L 184,205|L 389,205|L 389,0|Q 389,-127 340,-194|Q 292,-261 221,-289|L 172,-213'],
    // two contours, sorted as strings
    ['b6b56a85588dd75b55d3460aef5c3c143e8f505bc95e3ec46a9b922a214301f0', 'colon', [58],
      'M 184,0|L 184,205|L 389,205|L 389,0|L 184,0;M 184,856|L 184,1061|L 389,1061|L 389,856|L 184,856'],
    // a degenerate single-point contour (an anchor) next to a diamond
    ['6295b6808da8da03ae0fb009ac1da1a309269fa06369b3b5009648a5380363af', 'uni0902', [0x902],
      'M -277,1246;M -489,1594|L -356,1727|L -223,1594|L -356,1461|L -489,1594'],
  ];
  for (const [hash, name, codepoints, string] of golden) {
    assert.equal(sha256Hex(string), hash, `${name}: the committed hash is the SHA-256 of this canonical string`);
    assert.equal(table[hash].name, name);
    assert.deepEqual(table[hash].codepoints, codepoints);
  }
  // The same glyphs, read from the benchmark PDF's embedded subsets, produce exactly those strings and entries.
  const seen = new Map();
  for (const { program, usedGlyphs } of embeddedFonts(fixturePdf()).filter((f) => /ArialUnicode/.test(f.fontName))) {
    const { mapping, contours } = analyseSubsetGlyphs(program);
    for (const gid of usedGlyphs) seen.set(mapping.get(gid).name, { entry: mapping.get(gid), string: canonicalOutline(contours(gid)) });
  }
  for (const [hash, name, , string] of golden) {
    assert.equal(seen.get(name).string, string, `${name}: canonical outline from the fixture`);
    assert.deepEqual(seen.get(name).entry, table[hash]);
  }
});

// --- mapSubsetGlyphs on synthetic fonts ------------------------------------

test('mapSubsetGlyphs returns the table entry for each glyph ID, and U+0020 for an empty glyph', () => {
  const ka = entryFor('ka', 0x915);
  const kha = entryFor('kha', 0x916);
  const font = buildFont([
    simpleGlyph([square(0, 0)]), // gid 0: not in this table
    [], // gid 1: empty outline (space)
    simpleGlyph([square(10, 10, 50)]), // gid 2
    simpleGlyph([[pt(0, 0), pt(50, 0, false), pt(100, 100)]]), // gid 3
  ]);
  const table = tableOf([
    [[square(10, 10, 50)], ka],
    [[[pt(0, 0), pt(50, 0, false), pt(100, 100)]], kha],
  ]);
  const { mapping, unmatched } = analyseSubsetGlyphs(font, table);
  assert.equal(mapping.get(2), ka);
  assert.equal(mapping.get(3), kha);
  assert.equal(mapping.get(1), SPACE_ENTRY);
  assert.deepEqual(unmatched, [0]);
  assert.deepEqual([...mapSubsetGlyphs(font, table).keys()], [1, 2, 3]);
});

test('the subset cmap is ignored: a cmap that lies about every glyph changes nothing', () => {
  const entry = entryFor('ka', 0x915);
  const glyphs = [simpleGlyph([square(0, 0)]), simpleGlyph([square(10, 10, 50)])];
  const table = tableOf([[[square(10, 10, 50)], entry]]);
  const plain = buildFont(glyphs);
  const lying = buildFont(glyphs, { cmap: { 0x915: 0, 0x41: 1 } });
  assert.deepEqual([...mapSubsetGlyphs(lying, table)], [...mapSubsetGlyphs(plain, table)]);
  assert.equal(mapSubsetGlyphs(lying, table).get(1), entry);
});

test('font bytes re-serialised the way a PDF renderer may hand them over still map: ArrayBuffer, short loca, other table order', () => {
  const entry = entryFor('ka', 0x915);
  const glyphs = [simpleGlyph([square(0, 0)]), simpleGlyph([square(10, 10, 50)])];
  const table = tableOf([[[square(10, 10, 50)], entry]]);
  const reserialised = buildFont(glyphs, { shortLoca: true, order: ['glyf', 'loca', 'maxp', 'head'] });
  assert.equal(mapSubsetGlyphs(reserialised, table).get(1), entry);
  assert.equal(mapSubsetGlyphs(reserialised.buffer.slice(0), table).get(1), entry);
  const padded = new Uint8Array(reserialised.length + 7); // a view into a larger buffer
  padded.set(reserialised, 7);
  assert.equal(mapSubsetGlyphs(padded.subarray(7), table).get(1), entry);
});

test('composite glyphs are flattened: offset component hashes like the equivalent simple glyph', () => {
  const font = buildFont([
    simpleGlyph([square(0, 0)]),
    compositeGlyph([{ gid: 0, dx: 10, dy: 20 }]),
    simpleGlyph([square(10, 20)]),
  ]);
  const entry = entryFor('moved', 0x41);
  const { mapping } = analyseSubsetGlyphs(font, tableOf([[[square(10, 20)], entry]]));
  assert.equal(mapping.get(1), entry);
  assert.equal(mapping.get(2), entry);
});

test('composite scaling rounds fractional coordinates half to even, including negatives', () => {
  const source = [pt(0, 0), pt(0, 101), pt(103, 101), pt(103, 0)];
  const scaledSource = [pt(0, 0), pt(0, 50), pt(52, 50), pt(52, 0)];
  const negative = [pt(-101, -103), pt(-101, 0), pt(0, 0), pt(0, -103)];
  const scaledNegative = [pt(-50, -52), pt(-50, 0), pt(0, 0), pt(0, -52)];
  const font = buildFont([
    simpleGlyph([source]),
    compositeGlyph([{ gid: 0, dx: 0, dy: 0, scale: 0.5 }]),
    simpleGlyph([negative]),
    compositeGlyph([{ gid: 2, dx: 0, dy: 0, scale: 0.5 }]),
  ]);
  const a = entryFor('a', 1);
  const b = entryFor('b', 2);
  const { mapping } = analyseSubsetGlyphs(font, tableOf([[[scaledSource], a], [[scaledNegative], b]]));
  assert.equal(mapping.get(1), a);
  assert.equal(mapping.get(3), b);
});

test('composite point matching aligns the component to the parent point', () => {
  const sq = square(0, 0);
  const font = buildFont([
    simpleGlyph([sq]),
    compositeGlyph([{ gid: 0, dx: 0, dy: 0 }, { gid: 0, matchParent: 2, matchChild: 0 }]),
  ]);
  const entry = entryFor('pair', 0x42);
  const { mapping } = analyseSubsetGlyphs(font, tableOf([[[sq, square(100, 100)], entry]]));
  assert.equal(mapping.get(1), entry);
});

test('a malformed glyph is reported as unmatched instead of aborting the font', () => {
  const entry = entryFor('ka', 0x915);
  const full = buildFont([simpleGlyph([square(0, 0)]), simpleGlyph([square(5, 5, 60)])]);
  const cut = full.subarray(0, full.length - 12); // glyf is the last table: the last glyph is truncated
  const { mapping, unmatched } = analyseSubsetGlyphs(cut, tableOf([[[square(0, 0)], entry]]));
  assert.equal(mapping.get(0), entry);
  assert.deepEqual(unmatched, [1]);
});

test('a CFF or truncated font program is rejected with a descriptive error', () => {
  const table = { glyphs: {} };
  const cff = buildFont([simpleGlyph([square(0, 0)])], { sfnt: 0x4f54544f });
  assert.throws(() => mapSubsetGlyphs(cff, table), /embedded font is not a readable TrueType subset/);
  assert.throws(() => mapSubsetGlyphs(cff.subarray(0, 20), table), /embedded font is not a readable TrueType subset/);
  assert.throws(() => mapSubsetGlyphs(new Uint8Array(0), table), /embedded font is not a readable TrueType subset/);
});

// --- the committed table and the benchmark PDF -------------------------------

test('loadMasterTable loads the committed table; a missing table rejects with a clear error', async () => {
  const table = await loadMasterTable();
  assert.equal(Object.keys(table.glyphs).length, 811);
  await assert.rejects(
    loadMasterTable(new URL('./does-not-exist.json', import.meta.url)),
    /decoder table could not be loaded/,
  );
});

test('every glyph the text layer uses in each Arial Unicode MS subset of the benchmark PDF is matched', () => {
  const committed = committedTable();
  const fonts = embeddedFonts(fixturePdf()).filter((f) => /ArialUnicode/.test(f.fontName));
  assert.ok(fonts.length >= 2, 'expected the Arial Unicode MS subsets');
  let sawDevanagari = false;
  for (const { fontName, program, usedGlyphs } of fonts) {
    const mapping = mapSubsetGlyphs(program); // default table: the committed one
    const contoursOf = (bytes, gid) => analyseSubsetGlyphs(bytes).contours(gid);
    assert.ok(usedGlyphs.size > 0, `${fontName}: no glyphs found on the text layer`);
    assert.deepEqual([...usedGlyphs].filter((gid) => !mapping.has(gid)), [], `${fontName}: unmatched glyphs`);
    for (const gid of usedGlyphs) {
      const entry = mapping.get(gid);
      if (entry !== SPACE_ENTRY) assert.deepEqual(committed.glyphs[outlineHash(contoursOf(program, gid))], entry, 'entry is the committed table entry for the glyph hash');
      assert.ok(Array.isArray(entry.codepoints) && entry.codepoints.length > 0, `${fontName} glyph ${gid}`);
      if (entry.codepoints.some((cp) => cp >= 0x900 && cp <= 0x97f)) sawDevanagari = true;
    }
  }
  assert.ok(sawDevanagari, 'no Devanagari recovered from any subset');
});

test('analyseSubsetGlyphs reports glyphs outside the table instead of guessing', () => {
  const { program } = embeddedFonts(fixturePdf()).find((f) => /ArialUnicode/.test(f.fontName));
  const { mapping, unmatched } = analyseSubsetGlyphs(program, { glyphs: {} });
  assert.equal(mapping.size, [...mapping.values()].filter((e) => e === SPACE_ENTRY).length);
  assert.ok(unmatched.length > 0);
});

// --- the PDF reader, on synthetic PDFs -----------------------------------------

const latin1 = (bytes) => String.fromCharCode(...bytes);

function buildPdf(objects) {
  let out = '%PDF-1.4\n';
  for (const [num, body] of objects) {
    out += typeof body === 'string'
      ? `${num} 0 obj\n${body}\nendobj\n`
      : `${num} 0 obj\n<< ${body.dict ?? ''} /Length ${body.stream.length} >>\nstream\n${body.stream}\nendstream\nendobj\n`;
  }
  return Buffer.from(out, 'latin1');
}

// Page 3 draws "A", "B" and "C" in /F2 (Arial Unicode MS) and nothing in /F1.
function syntheticPdf({ pageResources, extra = [] }) {
  const unicodeFont = buildFont(
    [simpleGlyph([square(0, 0)]), simpleGlyph([square(1, 1)]), simpleGlyph([square(2, 2)]), simpleGlyph([square(3, 3)])],
    { cmap: { 65: 1, 66: 2, 67: 3 } },
  );
  const otherFont = buildFont([simpleGlyph([square(0, 0)]), simpleGlyph([square(9, 9)])], { cmap: { 65: 1 } });
  return buildPdf([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /Contents [4 0 R] ${pageResources} >>`],
    [4, { stream: 'BT /F2 12 Tf (A) Tj [(B) -20 <43>] TJ /F1 12 Tf ET' }],
    [5, '<< /ExtGState << /GS1 << /CA 1 >> >> /Font 6 0 R /ProcSet [/PDF /Text] >>'],
    [6, '<< /F1 7 0 R /F2 8 0 R >>'],
    [7, '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAC+Arial /FontDescriptor 9 0 R >>'],
    [8, '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAB+ArialUnicodeMS /FontDescriptor 10 0 R >>'],
    [9, '<< /Type /FontDescriptor /FontName /AAAAAC+Arial /FontFile2 12 0 R >>'],
    [10, '<< /Type /FontDescriptor /FontName /AAAAAB+ArialUnicodeMS /FontFile2 11 0 R >>'],
    [11, { dict: `/Length1 ${unicodeFont.length}`, stream: latin1(unicodeFont) }],
    [12, { dict: `/Length1 ${otherFont.length}`, stream: latin1(otherFont) }],
    ...extra,
  ]);
}

test('PDF reader: indirect /Resources and /Font, with nested dictionaries before /Font', () => {
  const fonts = embeddedFonts(syntheticPdf({ pageResources: '/Resources 5 0 R' }));
  assert.deepEqual(fonts.map((f) => f.fontName), ['AAAAAB+ArialUnicodeMS', 'AAAAAC+Arial']);
  assert.deepEqual([...fonts[0].usedGlyphs].sort(), [1, 2, 3]);
  assert.deepEqual([...fonts[1].usedGlyphs], [], '/F1 is selected but never shows text');
});

test('PDF reader: inline /Resources whose /Font follows nested dictionaries', () => {
  const fonts = embeddedFonts(syntheticPdf({
    pageResources: '/Resources << /ExtGState << /GS1 << /CA 1 >> >> /Font << /F1 7 0 R /F2 8 0 R >> >>',
  }));
  assert.deepEqual([...fonts[0].usedGlyphs].sort(), [1, 2, 3]);
});

test('PDF reader: a PDF with object streams is rejected, not silently read as having no text', () => {
  const pdf = syntheticPdf({ pageResources: '/Resources 5 0 R', extra: [[13, { dict: '/Type /ObjStm /N 1 /First 4', stream: '1 0 <<>>' }]] });
  assert.throws(() => embeddedFonts(pdf), /object streams/);
});

// --- the report command --------------------------------------------------------

const report = (...args) => spawnSync(process.execPath, [here('../../scripts/glyph-map-report.mjs'), ...args], { encoding: 'utf8' });

test('glyph-map-report prints matched/unmatched=0 for every Arial Unicode MS font in the benchmark PDF', () => {
  const run = report(here('../../fixtures/badli-ward1.pdf'));
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.match(line, /^\S*ArialUnicodeMS matched=\d+ unmatched=0$/);
});

test('glyph-map-report fails with a one-line message, not a stack trace, on a missing or non-PDF file', () => {
  const missing = report('/nonexistent/roll.pdf');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /^glyph-map-report: \/nonexistent\/roll\.pdf: /);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
  const notPdf = report(here('./CANONICAL_OUTLINE.md'));
  assert.notEqual(notPdf.status, 0);
  assert.match(notPdf.stderr, /no embedded Arial Unicode MS subset font found/);
  assert.equal(report().status, 2);
});
