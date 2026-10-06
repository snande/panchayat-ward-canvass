# Canonical outline hash

`master-glyph-table.json` maps a hash of a glyph's outline to the glyph's
identity in Arial Unicode MS. The font itself is not in this repository. A
decoder matches each glyph of the PDF's embedded subset font by computing
the same hash from the subset glyph's outline and looking it up here, so
the hash must be computed identically in every implementation.

## Input

The glyph's outline in font units (both fonts use 2048 units per em), with
composite glyphs flattened to their component contours and every coordinate
rounded to an integer.

## Contour normalisation

1. Each contour becomes a list of quadratic segments. A TrueType run of
   several off-curve points is split at the implied on-curve midpoints, so
   every segment is either `L x,y` (line to an on-curve point) or
   `Q cx,cy x,y` (one control point then one on-curve end point). A contour
   with no on-curve point at all gets a synthetic start point at the
   midpoint of its first two off-curve points.
2. The segment list is closed back to its start point with an `L` segment
   if the last segment does not already end there.
3. The list is rotated so that the contour starts at its lexicographically
   smallest on-curve point (compare x, then y; on a tie, the first
   occurrence). It is written as `M x,y` followed by the segments in order.
4. The contour string is the parts joined with `|`.

## Glyph string and hash

Contour strings are sorted as plain strings and joined with `;`. The hash
is the lowercase hex SHA-256 of that string encoded as UTF-8. A glyph with
no contours (the space) has the empty glyph string and is not in the table;
a decoder maps it to U+0020 directly.

Example of a contour string prefix: `M 102,-31|Q 102,210 350,210|L 350,1832|...`

## Table entries

```
"<hash>": {"gid": <master glyph id>, "name": "<master glyph name>",
           "kind": "base" | "ligature" | "half" | "reph" | "below" | "post" | "variant" | "variant+mark",
           "codepoints": [<Unicode scalar values in logical order>]}
```

`codepoints` is the glyph's expansion into Unicode, derived once from the
font's own cmap and GSUB tables: a base glyph is its cmap code point; a
ligature is its components expanded in order; a half form is the consonant
plus virama; the standalone reph glyph is ra plus virama; a below-base
(rakar) or post-base form is virama plus the consonant. Inside a ligature a
ra-plus-virama component that follows a consonant is the below-base ra, so
it is emitted as virama plus ra. The contextual i-matra variants that fuse a
reph, an anusvara or a candrabindu into the matra glyph are decoded from
their outlines (hook length and extra contours) and carry those marks in
their expansion; see `tools/reference-decoder/glyphtable.py`.

Expansions are in the order the glyph's parts are written logically, not
the order they are drawn. Two reorderings remain for the decoder after the
glyphs of a line are concatenated in drawing order: an i-matra (with any
marks and fused reph) is drawn before the consonant cluster it follows
logically, and a standalone reph is drawn after the syllable it precedes
logically. `tools/reference-decoder/decode.py` has both rules.

Scope: the table covers the Devanagari block, basic Latin, Latin-1, general
punctuation, U+25CC, and every glyph reachable from those through GSUB
(811 glyphs). Five pairs of distinct glyphs share an outline; the first by
glyph id is kept.

## Fallbacks and the space glyph

`meta.spaceGid` and `meta.spaceAdvance` record the master space glyph (3)
and its advance (569). A subset glyph with no contours maps to it only if
its advance, scaled to 2048 units per em, is within one unit of that.

`index.shapes` maps an entry's hash to its shape: the canonical string of
the outline after translating it so its minimum x and y are 0. When the
exact hash misses, `mapSubsetGlyphs` first looks for an entry with an equal
shape (the same outline at another offset). Failing that, it takes the entry
whose shape has the same structure (identical with every number removed)
and whose coordinates differ by at most 8 units, provided exactly one master
glyph is nearest. `scripts/build-glyph-table.mjs` writes a shape for every
entry. `scripts/seed-glyph-index.mjs` adds shapes without the font, from
subset glyphs in roll PDFs whose hash is an exact entry; `index.coverage`
says which.
