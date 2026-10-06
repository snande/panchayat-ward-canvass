import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mapSubsetGlyphs, analyseSubsetGlyphs, canonicalOutline, outlineHash, SPACE_ENTRY } from './glyphMap.js';
import { sha256Hex } from './sha256.js';
import { embeddedFonts } from '../../scripts/pdf-fonts.mjs';

const pt = (x, y, on = true) => ({ x, y, on });

test('sha256Hex matches the standard test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('canonical outline: lines, rotated to the smallest on-curve point and closed', () => {
  const square = [pt(100, 100), pt(0, 100), pt(0, 0), pt(100, 0)];
  assert.equal(canonicalOutline([square]), 'M 0,0|L 100,0|L 100,100|L 0,100|L 0,0');
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
  const at = (n) => [pt(n, n), pt(n, n + 10), pt(n + 10, n + 10), pt(n + 10, n)];
  const joined = canonicalOutline([at(50), at(5)]);
  assert.deepEqual(joined.split(';').map((s) => s.slice(0, 6)), ['M 5,5|', 'M 50,5']);
  assert.equal(canonicalOutline([at(5), at(50)]), joined);
});

test('an empty outline has the empty glyph string and no hash', () => {
  assert.equal(canonicalOutline([]), '');
  assert.equal(outlineHash([]), '');
  assert.deepEqual(SPACE_ENTRY.codepoints, [0x20]);
});

test('every glyph the text layer uses in each Arial Unicode MS subset of the benchmark PDF is matched', () => {
  const pdf = readFileSync(fileURLToPath(new URL('../../fixtures/badli-ward1.pdf', import.meta.url)));
  const fonts = embeddedFonts(pdf).filter((f) => /ArialUnicode/.test(f.fontName));
  assert.ok(fonts.length >= 2, 'expected the Arial Unicode MS subsets');
  let sawDevanagari = false;
  for (const { fontName, program, usedGlyphs } of fonts) {
    const mapping = mapSubsetGlyphs(program);
    assert.ok(mapping instanceof Map);
    assert.ok(usedGlyphs.size > 0, `${fontName}: no glyphs found on the text layer`);
    const missing = [...usedGlyphs].filter((gid) => !mapping.has(gid));
    assert.deepEqual(missing, [], `${fontName}: unmatched glyphs`);
    for (const gid of usedGlyphs) {
      const entry = mapping.get(gid);
      assert.ok(Array.isArray(entry.codepoints) && entry.codepoints.length > 0, `${fontName} glyph ${gid}`);
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.kind, 'string');
    }
    for (const gid of usedGlyphs) {
      if (mapping.get(gid).codepoints.some((cp) => cp >= 0x900 && cp <= 0x97f)) sawDevanagari = true;
    }
  }
  assert.ok(sawDevanagari, 'no Devanagari recovered from any subset');
});

test('analyseSubsetGlyphs reports glyphs outside the master table instead of guessing', () => {
  const pdf = readFileSync(fileURLToPath(new URL('../../fixtures/badli-ward1.pdf', import.meta.url)));
  const { program } = embeddedFonts(pdf).find((f) => /ArialUnicode/.test(f.fontName));
  const { mapping, unmatched } = analyseSubsetGlyphs(program, { glyphs: {} });
  assert.equal(mapping.size, [...mapping.values()].filter((e) => e === SPACE_ENTRY).length);
  assert.ok(unmatched.length > 0);
});
