#!/usr/bin/env node
// Build src/decoder/master-glyph-table.json from Arial Unicode MS:
//   node scripts/build-glyph-table.mjs [fonts/ARIALUNI.TTF] [src/decoder/master-glyph-table.json]
//
// A port of tools/reference-decoder/glyphtable.py. It hashes every in-scope
// master glyph with the canonical outline hash (CANONICAL_OUTLINE.md) and
// records its glyph id, name, kind and Unicode expansion (from the font's
// cmap and GSUB). It also writes two fallback indexes the decoder uses when an
// exact hash misses: "offset" (outline hash with the offset removed) and
// "coarse" (offset-free outline on an 8-unit grid). The font is not committed
// (licence); the decoder needs only the JSON this writes, never the font.

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseTrueType } from "../src/decoder/truetype.js";
import { outlineHash, offsetFreeHash, coarseHash, penContours } from "../src/decoder/outlineHash.js";

const fontPath = process.argv[2] || "fonts/ARIALUNI.TTF";
const outPath = process.argv[3] || "src/decoder/master-glyph-table.json";

let bytes;
try {
  bytes = new Uint8Array(await readFile(fontPath));
} catch {
  console.error(`${fontPath}: not found. Arial Unicode MS is not committed (licence); copy it there`);
  console.error(`(macOS: "/Library/Fonts/Arial Unicode.ttf") or pass its path as the first argument.`);
  process.exit(1);
}
const font = parseTrueType(bytes);
const dv = font.view;
const u16 = (o) => dv.getUint16(o);
const VIRAMA = 0x94d;
const isCons = (c) => (c >= 0x915 && c <= 0x939) || (c >= 0x958 && c <= 0x95f);

// ---- glyph names (post format 2; otherwise fontTools-style "glyphNNNNN") ----
const names = Array.from({ length: font.numGlyphs }, (_, i) => (i === 0 ? ".notdef" : `glyph${String(i).padStart(5, "0")}`));
if (font.tables.post && dv.getUint32(font.tables.post.offset) === 0x20000) {
  const post = font.tables.post.offset;
  const { STANDARD_MAC_NAMES } = await import("./lib/macGlyphNames.mjs");
  const n = u16(post + 32);
  const idx = Array.from({ length: n }, (_, i) => u16(post + 34 + i * 2));
  const extra = [];
  for (let p = post + 34 + n * 2; p < post + font.tables.post.length; ) {
    const len = dv.getUint8(p);
    extra.push(new TextDecoder("latin1").decode(font.bytes.subarray(p + 1, p + 1 + len)));
    p += 1 + len;
  }
  idx.forEach((k, gid) => { if (gid < names.length) names[gid] = k < 258 ? STANDARD_MAC_NAMES[k] : extra[k - 258]; });
}

// ---- best cmap (fontTools getBestCmap order), code points ascending ----
function cmapEntries() {
  const t = font.tables.cmap;
  const subs = new Map();
  for (let i = 0; i < u16(t.offset + 2); i++) {
    const rec = t.offset + 4 + i * 8;
    subs.set(`${u16(rec)}/${u16(rec + 2)}`, t.offset + dv.getUint32(rec + 4));
  }
  for (const key of ["3/10", "0/6", "0/4", "3/1", "0/3", "0/2", "0/1", "0/0"]) {
    const o = subs.get(key);
    if (o === undefined) continue;
    const format = u16(o), out = [];
    if (format === 4) {
      const segX2 = u16(o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let i = 0; i < segX2; i += 2) {
        const end = u16(ends + i), start = u16(starts + i), delta = dv.getInt16(deltas + i), ro = u16(ranges + i);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (!ro) g = (c + delta) & 0xffff;
          else { g = u16(ranges + i + ro + (c - start) * 2); if (g) g = (g + delta) & 0xffff; }
          if (g) out.push([c, g]);
        }
      }
    } else if (format === 12) {
      for (let i = 0; i < dv.getUint32(o + 12); i++) {
        const g = o + 16 + i * 12, s = dv.getUint32(g), e = dv.getUint32(g + 4), sg = dv.getUint32(g + 8);
        for (let c = s; c <= e; c++) out.push([c, sg + c - s]);
      }
    } else continue;
    return out.sort((a, b) => a[0] - b[0]);
  }
  throw new Error("no usable Unicode cmap");
}
const cmap = cmapEntries();
const cmapOf = new Map(cmap);
const cpOf = new Map();
for (const [cp, g] of cmap) if (!cpOf.has(g)) cpOf.set(g, cp);

// ---- GSUB: reverse single (type 1) and ligature (type 4) substitutions ----
const ligRev = new Map(), singleRev = new Map(); // gid -> {comps|inp, tags}
if (font.tables.GSUB) {
  const g = font.tables.GSUB.offset;
  const featureList = g + u16(g + 6), lookupList = g + u16(g + 8);
  const feats = new Map(); // lookup index -> Set(tag)
  for (let i = 0; i < u16(featureList); i++) {
    const rec = featureList + 2 + i * 6;
    const tag = new TextDecoder("latin1").decode(font.bytes.subarray(rec, rec + 4));
    const f = featureList + u16(rec + 4);
    for (let j = 0; j < u16(f + 2); j++) {
      const li = u16(f + 4 + j * 2);
      if (!feats.has(li)) feats.set(li, new Set());
      feats.get(li).add(tag);
    }
  }
  const coverage = (o) => {
    const out = [];
    if (u16(o) === 1) for (let i = 0; i < u16(o + 2); i++) out.push(u16(o + 4 + i * 2));
    else for (let i = 0; i < u16(o + 2); i++) {
      const r = o + 4 + i * 6;
      for (let gid = u16(r); gid <= u16(r + 2); gid++) out.push(gid);
    }
    return out;
  };
  for (let li = 0; li < u16(lookupList); li++) {
    const lk = lookupList + u16(lookupList + 2 + li * 2);
    const tags = [...(feats.get(li) || [])].sort();
    for (let s = 0; s < u16(lk + 4); s++) {
      let st = lk + u16(lk + 6 + s * 2), kind = u16(lk);
      if (kind === 7) { kind = u16(st + 2); st = st + dv.getUint32(st + 4); }
      if (kind === 1) {
        const cov = coverage(st + u16(st + 2));
        cov.forEach((inp, i) => {
          const out = u16(st) === 1 ? (inp + dv.getInt16(st + 4)) & 0xffff : u16(st + 6 + i * 2);
          if (!singleRev.has(out)) singleRev.set(out, { inp, tags });
        });
      } else if (kind === 4) {
        const cov = coverage(st + u16(st + 2));
        cov.forEach((first, i) => {
          const set = st + u16(st + 6 + i * 2);
          for (let j = 0; j < u16(set); j++) {
            const lig = set + u16(set + 2 + j * 2);
            const ligGlyph = u16(lig), n = u16(lig + 2);
            const comps = [first];
            for (let k = 0; k < n - 1; k++) comps.push(u16(lig + 4 + k * 2));
            if (!ligRev.has(ligGlyph)) ligRev.set(ligGlyph, { comps, tags });
          }
        });
      }
    }
  }
}

// ---- Unicode expansion of a glyph ----
function expand(g, depth = 0) {
  if (cpOf.has(g)) return [[cpOf.get(g)], "base"];
  if (depth > 6) return [null, "unresolved"];
  if (ligRev.has(g)) {
    const out = [];
    const { comps } = ligRev.get(g);
    for (let n = 0; n < comps.length; n++) {
      let [seq] = expand(comps[n], depth + 1);
      if (seq === null) return [null, "unresolved"];
      // ra+virama after a consonant inside a ligature is the below-base ra.
      if (n > 0 && seq.length === 2 && seq[0] === 0x930 && seq[1] === VIRAMA && out.length && isCons(out[out.length - 1])) seq = [VIRAMA, 0x930];
      out.push(...seq);
    }
    return [out, "ligature"];
  }
  if (singleRev.has(g)) {
    const { inp, tags } = singleRev.get(g);
    const [seq] = expand(inp, depth + 1);
    if (seq === null) return [null, "unresolved"];
    if (tags.includes("half")) return [[...seq, VIRAMA], "half"];
    if (tags.includes("pstf")) return [[VIRAMA, ...seq], "post"];
    if (tags.includes("rphf")) return [[...seq, VIRAMA], "reph"];
    if (tags.includes("blwf") || tags.includes("vatu")) return [[VIRAMA, ...seq], "below"];
    return [seq, "variant"];
  }
  return [null, "unresolved"];
}

// ---- scope: Devanagari, basic Latin, Latin-1, general punctuation, U+25CC, and GSUB closure ----
const scope = new Set();
for (const [cp, g] of cmap) {
  if ((cp >= 0x900 && cp <= 0x97f) || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || (cp >= 0x2000 && cp <= 0x206f) || cp === 0x25cc) scope.add(g);
}
for (let grew = true; grew; ) {
  grew = false;
  const next = [];
  for (const [out, { comps }] of ligRev) if (!scope.has(out) && comps.every((c) => scope.has(c))) next.push(out);
  for (const [out, { inp }] of singleRev) if (!scope.has(out) && scope.has(inp)) next.push(out);
  for (const g of next) { scope.add(g); grew = true; }
}

// ---- contextual i-matra / ii-matra variants that carry a mark (glyphtable.py with_mark) ----
function contourBoxes(g) {
  const boxes = [];
  for (const c of penContours(font.glyphContours(g))) {
    const pts = c.map(([op, a]) => (op === "Q" ? a.slice(2) : a));
    if (pts.length < 3) continue;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return boxes;
}
const sameBox = (a, b) => a.every((v, i) => v === b[i]);
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const largest = (bs) => bs.reduce((m, b) => (area(b) > area(m) ? b : m));
const I_MATRA_PLAIN_WIDTHS = [1260, 1450, 1590]; // the three hook lengths of a plain i-matra in this font
function withMark(g) {
  if (!singleRev.has(g)) return null;
  const inp = singleRev.get(g).inp;
  const vb = contourBoxes(g), ib = contourBoxes(inp);
  if (!vb.length || !ib.length) return null;
  const out = [];
  const main = largest(vb), baseMain = largest(ib);
  let root = inp;
  for (let hops = 0; !cpOf.has(root) && singleRev.has(root) && hops < 6; hops++) root = singleRev.get(root).inp;
  const isIMatra = cpOf.get(root) === 0x93f;
  // A hook wider than any plain i-matra has the reph fused into it.
  if (isIMatra && main[1] < 0 && main[3] > 1800 && I_MATRA_PLAIN_WIDTHS.every((w) => Math.abs(main[2] - w) > 10)) out.push(0x930, VIRAMA);
  const extras = vb.filter((b) => !sameBox(b, main));
  if (extras.length === 1) {
    const [x0, y0, x1, y1] = extras[0];
    if (x1 - x0 >= 150 && x1 - x0 <= 400 && y1 - y0 >= 150 && y1 - y0 <= 400 && y0 > 1300) out.push(0x902); // anusvara
    else return null;
  } else if (extras.length === 2) {
    const big = extras.reduce((m, b) => (b[2] - b[0] > m[2] - m[0] ? b : m));
    if (big[2] - big[0] > 500 && big[1] > 1500) out.push(0x901); // candrabindu
    else return null;
  } else if (extras.length) return null;
  if (!out.length) return null;
  if (!sameBox(main, baseMain) && !(isIMatra && out[0] === 0x930 && out[1] === VIRAMA) && extras.length === 0) return null;
  return out;
}

// ---- the table ----
const glyphs = {}, offsetIndex = {}, coarseIndex = {};
let collisions = 0, unresolved = 0, marked = 0;
for (const g of [...scope].sort((a, b) => a - b)) {
  const contours = font.glyphContours(g);
  const h = outlineHash(contours);
  if (!h) continue;
  let [seq, kind] = expand(g);
  if (kind === "variant") {
    let mark = withMark(g);
    if (mark) {
      const tail = seq.slice(-mark.length);
      if (tail.length === mark.length && tail.every((v, i) => v === mark[i])) mark = []; // the base expansion already carries it
      else if ([0x901, 0x902].includes(mark[mark.length - 1]) && seq[seq.length - 1] === mark[mark.length - 1]) mark = mark.slice(0, -1);
      if (mark.length) { seq = [...seq, ...mark]; kind = "variant+mark"; marked++; }
    }
  }
  if (seq === null) unresolved++;
  if (glyphs[h]) { collisions++; continue; }
  glyphs[h] = { gid: g, name: names[g], kind, codepoints: seq };
  const oh = offsetFreeHash(contours);
  if (!(oh in offsetIndex)) offsetIndex[oh] = h;
  (coarseIndex[coarseHash(contours)] ||= []).push(h);
}

const meta = {
  source: `Arial Unicode MS (${basename(fontPath)})`,
  unitsPerEm: font.unitsPerEm,
  glyphs: Object.keys(glyphs).length,
  scope: "Devanagari U+0900-097F, basic Latin, Latin-1, general punctuation, U+25CC, plus every glyph reachable from them through GSUB",
  hash: "sha256 hex of the canonical outline string; see CANONICAL_OUTLINE.md",
  spaceGid: cmapOf.get(0x20) ?? 3,
};
// Same layout as the Python builder's json.dump(indent=0).
const json = JSON.stringify({ meta, glyphs, index: { offset: offsetIndex, coarse: coarseIndex } }, null, 1).replace(/^ +/gm, "");
await writeFile(outPath, json);
console.log(`scope glyphs: ${scope.size} table entries: ${meta.glyphs} collisions: ${collisions} unresolved: ${unresolved} variants with a mark: ${marked} upem: ${font.unitsPerEm}`);
const kinds = {};
for (const e of Object.values(glyphs)) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
console.log("kinds:", JSON.stringify(kinds));
