// Write a minimal TrueType font (head, hhea, maxp, hmtx, loca, glyf and an
// optional cmap) for tests. Glyphs are either simple, {contours: [[{x,y,on}]]},
// or composite, {components: [{glyph, dx, dy} | {glyph, match: [parentPt, childPt]}]};
// each may carry an `advance`.

export function buildTrueType({ glyphs, unitsPerEm = 2048, cmap = null }) {
  const glyf = [], loca = [0];
  for (const g of glyphs) {
    const bytes = g.components ? compositeGlyph(g.components) : g.contours?.length ? simpleGlyph(g.contours) : [];
    while (bytes.length % 4) bytes.push(0);
    glyf.push(...bytes);
    loca.push(glyf.length);
  }
  const tables = {
    head: head(unitsPerEm),
    hhea: hhea(glyphs.length),
    maxp: [...u32(0x00005000), ...u16(glyphs.length)],
    hmtx: glyphs.flatMap((g) => [...u16(g.advance ?? 1000), ...u16(0)]),
    loca: loca.flatMap(u32),
    glyf,
  };
  if (cmap) tables.cmap = cmapTable(cmap);
  return sfnt(tables);
}

/** cmap with one format-0 subtable: {platform, encoding, map: {code: gid}}. */
function cmapTable({ platform, encoding, map }) {
  const ids = new Array(256).fill(0);
  for (const [c, g] of Object.entries(map)) ids[Number(c)] = g;
  return [...u16(0), ...u16(1), ...u16(platform), ...u16(encoding), ...u32(12), ...u16(0), ...u16(262), ...u16(0), ...ids];
}

function simpleGlyph(contours) {
  const pts = contours.flat();
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const out = [...i16(contours.length), ...bbox(xs, ys)];
  let end = -1;
  for (const c of contours) { end += c.length; out.push(...u16(end)); }
  out.push(...u16(0)); // no instructions
  for (const p of pts) out.push(p.on ? 1 : 0);
  let prev = 0;
  for (const p of pts) { out.push(...i16(p.x - prev)); prev = p.x; }
  prev = 0;
  for (const p of pts) { out.push(...i16(p.y - prev)); prev = p.y; }
  return out;
}

function compositeGlyph(components) {
  const out = [...i16(-1), ...i16(0), ...i16(0), ...i16(0), ...i16(0)];
  components.forEach((c, i) => {
    const more = i < components.length - 1 ? 0x20 : 0;
    if (c.match) out.push(...u16(0x0001 | more), ...u16(c.glyph), ...u16(c.match[0]), ...u16(c.match[1]));
    else out.push(...u16(0x0001 | 0x0002 | more), ...u16(c.glyph), ...i16(c.dx ?? 0), ...i16(c.dy ?? 0));
  });
  return out;
}

function head(unitsPerEm) {
  const h = new Array(54).fill(0);
  h.splice(0, 4, ...u32(0x00010000));
  h.splice(12, 4, ...u32(0x5f0f3cf5));
  h.splice(18, 2, ...u16(unitsPerEm));
  h.splice(50, 2, ...i16(1)); // long loca
  return h;
}

function hhea(numberOfHMetrics) {
  const h = new Array(36).fill(0);
  h.splice(0, 4, ...u32(0x00010000));
  h.splice(34, 2, ...u16(numberOfHMetrics));
  return h;
}

function sfnt(tables) {
  const tags = Object.keys(tables).sort();
  const out = [...u32(0x00010000), ...u16(tags.length), ...u16(0), ...u16(0), ...u16(0)];
  let offset = 12 + tags.length * 16;
  const bodies = [];
  for (const tag of tags) {
    const body = [...tables[tag]];
    out.push(...[...tag].map((ch) => ch.charCodeAt(0)), ...u32(0), ...u32(offset), ...u32(body.length));
    while (body.length % 4) body.push(0);
    bodies.push(body);
    offset += body.length;
  }
  return Uint8Array.from([...out, ...bodies.flat()]);
}

function bbox(xs, ys) {
  return [...i16(Math.min(...xs)), ...i16(Math.min(...ys)), ...i16(Math.max(...xs)), ...i16(Math.max(...ys))];
}
function u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }
function i16(v) { return u16(v & 0xffff); }
function u32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }
