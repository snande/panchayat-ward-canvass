# Reference decoder (Python)

A working, hand-verified decoder for the State Election Commission of
Rajasthan's 2026 panchayat roll PDFs, kept here as the specification for the
JavaScript decoder the product ships. It is not part of the app.

What it does, in order:

1. For each page's form XObject, reads every embedded Arial Unicode MS
   subset font, hashes each glyph's outline with the canonical form in
   `glyphtable.py` (specified in `src/decoder/CANONICAL_OUTLINE.md`), and
   looks the hash up in `src/decoder/master-glyph-table.json` to get the
   glyph's Unicode expansion. The subset's own ToUnicode map is never used:
   it is lossy (91 codes onto 36 letters in this roll).
2. Parses the content stream's literal strings with a real PDF string
   tokenizer. Names containing घ, च or आ are encoded as the backslash and
   parenthesis bytes and arrive escaped; a regex breaks on them.
3. Assembles each line from its text runs: a run that starts with a
   combining mark or a reph, or that is positioned within two units of the
   previous run, or that follows a marks-only run, continues the line.
4. Reorders the line from drawing order to logical Unicode order
   (`reorder`): i-matra after its cluster, standalone reph before its
   syllable, a reph fused into an i-matra glyph before the cluster that
   matra follows.
5. Parses entries by row: an entry opens at a `नाम:` label and closes at the
   bold serial (Times New Roman); each value sits on the row of its label.
   A struck-off mark in the serial font sits on the serial's row just left
   of the serial: `O` in Badli's roll, the legend letter `E`, `S` or `R`
   (deleted due to death, shifting or repetition) in the SEC's 2026 rolls.
   It is drawn after the serial in the main list but before it in a
   supplement's deletion list, so it is matched to the serial by position
   once the page is parsed. A `#` (a modified entry) strikes off nothing.
   The supplement's deletion list repeats struck-off entries; one record
   per serial is kept.

Run it:

```
python -m venv venv && venv/bin/pip install pypdf fonttools
cd tools/reference-decoder
../../venv/bin/python decode.py ../../fixtures/badli-ward1.pdf ../../src/decoder/master-glyph-table.json /tmp/out
```

It writes `/tmp/out/entries.json` (all serials with a `deleted` flag) and a
per-page text dump. Against `fixtures/badli-ward1-expected.json` it scores
297 of 297.

`expected.py` writes the expected-entries fixture `decodeRoll` is tested
against (`test/secFixtures.test.js`): every entry, struck-off ones included,
with the stored fields `serial, name, relative, age, gender, house, struck`,
one entry per line, next to the PDF:

```
cd tools/reference-decoder
../../venv/bin/python expected.py ../../fixtures/sec/bharatpur/ARAUDA-ward-001.pdf
```

Rebuilding the glyph table needs Arial Unicode MS, which macOS ships at
`/Library/Fonts/Arial Unicode.ttf` and which is not committed:

```
python glyphtable.py "/Library/Fonts/Arial Unicode.ttf" ../../src/decoder/master-glyph-table.json
```

Known limits: the i-matra variant rules are specific to this font's three
hook lengths; the entry parser is specific to this roll layout (one
generator, iTextSharp 4.0.6, across the whole state); other states' rolls
are out of scope.
