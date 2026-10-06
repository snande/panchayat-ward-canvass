# panchayat-ward-canvass

Offline decoder for the State Election Commission of Rajasthan's panchayat
roll PDFs. It works from the PDF text layer only: no OCR, no upload, no
Kruti Dev mapping and no network call. The modules are plain ES modules
that the PWA imports in the browser; the scripts run them in Node 22+.
There are no dependencies to install.

## Glyph identity

The rolls embed subsets of Arial Unicode MS whose glyph ids, cmap and
ToUnicode data do not identify the real Devanagari glyphs. The decoder
recovers each glyph by its outline:

- `src/decoder/glyphMap.js`: `mapSubsetGlyphs(fontProgramBytes)` takes a raw
  embedded FontFile2 program and returns a `Map` from subset glyph id to
  Arial Unicode MS glyph id. It normalises the subset's units-per-em to
  2048, hashes each glyph's canonical outline
  (`src/decoder/CANONICAL_OUTLINE.md`) and looks it up in
  `src/decoder/master-glyph-table.json`, which also gives the glyph's
  Unicode expansion. On a miss it compares the outline with its offset
  removed, then looks for the nearest outline of the same structure within
  8 font units. A glyph with no outline is the space only if its advance is
  the space's. The subset's cmap and ToUnicode are never read.
- `src/decoder/truetype.js` reads glyf/loca outlines; `src/pdf/embeddedFonts.js`
  pulls the raw font programs, and the codes each font shows, out of the PDF.

Check every embedded subset of the benchmark roll (CI runs this and `npm test`):

```
node scripts/glyph-map-report.mjs fixtures/badli-ward1.pdf
# <fontName> matched=<n> unmatched=0, one line per embedded subset
```

## The master table

`scripts/build-glyph-table.mjs` builds the table from the licensed font, which
is not committed:

```
node scripts/build-glyph-table.mjs fonts/ARIALUNI.TTF src/decoder/master-glyph-table.json
```

The committed glyph entries come from the Python reference builder
(`tools/reference-decoder/glyphtable.py`), which the JavaScript builder ports.
Their fallback shapes and the space record were added without the font by
`scripts/seed-glyph-index.mjs fixtures/badli-ward1.pdf`, so they cover the
138 entries the benchmark roll uses (see `index.coverage`). A rebuild from
the font covers every entry. The shipped decoder needs only the JSON table,
never the font.
