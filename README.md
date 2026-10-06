# panchayat-ward-canvass

Offline decoder for the State Election Commission of Rajasthan's panchayat
roll PDFs. It works from the PDF text layer only: no OCR, no upload, no
Kruti Dev mapping and no network call. The modules are plain ES modules
that the PWA imports in the browser; the scripts run them in Node 22+.

## Glyph identity

The rolls embed subsets of Arial Unicode MS whose glyph ids, cmap and
ToUnicode data do not identify the real Devanagari glyphs. The decoder
recovers each glyph by its outline:

- `src/decoder/glyphMap.js`: `mapSubsetGlyphs(fontProgramBytes)` takes a raw
  embedded FontFile2 program and returns a `Map` from subset glyph id to
  Arial Unicode MS glyph id. It hashes each glyph's canonical outline
  (`src/decoder/CANONICAL_OUTLINE.md`; units-per-em normalised to 2048) and
  looks it up in `src/decoder/master-glyph-table.json`, which also gives the
  glyph's Unicode expansion. When the table carries its fallback indexes, a
  miss is retried with the offset removed and then on a coarse grid. The
  subset's cmap and ToUnicode are never read.
- `src/decoder/truetype.js` reads glyf/loca outlines; `src/pdf/embeddedFonts.js`
  pulls the raw font programs and the codes each font shows out of the PDF.

Check every embedded subset of the benchmark roll (CI runs this):

```
node scripts/glyph-map-report.mjs fixtures/badli-ward1.pdf
# <fontName> matched=<n> unmatched=0, one line per embedded subset
```

Rebuild the master table (needs the licensed font, which is not committed):

```
node scripts/build-glyph-table.mjs fonts/ARIALUNI.TTF src/decoder/master-glyph-table.json
```

The shipped decoder needs only the JSON table, never the font.
`tools/reference-decoder` is the Python specification the JavaScript follows.
