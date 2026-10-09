# Benchmark fixtures: Badli ward 1

`badli-ward1.pdf` is the State Election Commission of Rajasthan's final
panchayat roll for Jaipur district, Chaksu panchayat samiti, Badli gram
panchayat, ward 1, exactly as served on 2026-10-06 from the commission's
public roll server (`esuchiroll.rajasthan.gov.in`, path
`Publication_PDF_2026/PRI/Final/125/BADLI-Ward No-001.pdf`, 257,132 bytes,
last modified 23 Feb 2026). It is the only input the decoder benchmark reads.

`badli-ward1-expected.json` is the ground truth: a JSON array of exactly 297
objects, in roll order, one per voter on the final roll. The roll's original
list runs to serial 318, a supplement adds serials 319 to 326, and 29 serials
are struck off (marked with an "O" before the serial and a DELETED stamp);
326 minus 29 is 297, which is the total the roll's own cover and summary
pages state (154 men, 143 women). Struck-off serials are not in this file.

Every object has these keys, and "matching exactly" compares all of them:

| key | type | meaning |
|---|---|---|
| `serial` | integer | the roll serial number |
| `name` | string | the voter's name, Unicode Devanagari, words separated by one space |
| `relation` | string | the label printed before the relative's name: पति, पिता, माता, पत्नी or अन्य |
| `relative` | string | the relative's name, Unicode Devanagari |
| `age` | integer | age as printed |
| `gender` | string | as printed: स्त्री or पुरूष (the roll spells it with a long u) |
| `house` | string | house number as printed, including a leading zero where the roll has one |
| `epic` | string or null | the EPIC number as printed; null for the eight supplement entries, which carry none |

Names are the roll's own spelling and spacing, including its inconsistencies
(for example a relative printed twice in serial 246, and जांगिड with and
without a nukta on neighbouring entries). Nothing was corrected.

`badli-ward1-all-serials.json` has the same shape for all 326 serials with a
`deleted` flag, for decoders that want to report struck-off entries.

How the ground truth was made: the reference decoder under
`tools/reference-decoder` produced a first pass; every page was then
rendered to an image and each of the 326 entries was compared by eye
against the rendered page, field by field. Two names the first pass had
wrong (serials 103 and 320, both missing a reph fused into the i-matra
glyph) were corrected in the decoder, and the pass was re-run and
re-compared; no other entry changed. The reference decoder now matches
this file on 297 of 297 records.

# SEC rolls: expected entries for five districts

`fixtures/sec/` holds 77 ward roll PDFs from five districts
(`fixtures/sec/manifest.json`). Five of them, one per district directory,
have a committed `<roll>.expected.json` that `test/secFixtures.test.js`
compares `decodeRoll` against line for line: serial order, name, relative,
age, gender, house and the `struck` flag.

| district | roll | entries | struck off |
|---|---|---|---|
| bharatpur | `ARAUDA-ward-001` (Final) | 298 | 26 |
| bhilwara | `ALMAS-ward-001-supp-2` | 376 | 6 |
| bikaner | `BHOLASAR-ward-001-supp-2` | 425 | 8 |
| jodhpur | `ASHAPURA-ward-005-supp-2` | 200 | 16 |
| udaipur | `AMARPURA-ward-001-supp-2` | 425 | 2 |

Each file is `tools/reference-decoder/expected.py`'s output format.
These rolls mark a struck-off entry with the legend letter E, S or R (not
Badli's "O"), drawn left of the serial; the supplement's deletion list
("घटक 2: विलोपन सूची") repeats it, and an entry in the modification list
("घटक 3: संशोधन सूची") carries a "#" and is not struck off. In Almas ward 1
the six struck-off serials (81, 186, 220, 244, 258, 308) are the six EPIC
numbers repeated in a deletion list; serial 7, repeated in the modification
list, is not struck off.

How these five files were made: `pypdf` and `fontTools` could not be
installed where they were generated, so `decode.py`'s own `roll_entries`
(entry parsing, struck-off marks, de-duplication) and `expected.py`'s
`project` were run on each page's text lines as assembled by
`src/decoder/decodeRoll.js` `pageLines` (the port of `decode.py`'s
`page_lines`, which matches it on Badli ward 1). Regenerate them with the
full reference decoder, as `expected.py` runs it, where `pypdf` and
`fontTools` are available, and commit any difference.

