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
