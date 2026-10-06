# Badli ward 1 decoder benchmark

Input: `fixtures/badli-ward1.pdf`. Ground truth: `fixtures/badli-ward1-expected.json`.
Decoder: `src/decoder/decodeRoll.js` (glyph outlines matched to `src/decoder/master-glyph-table.json`;
no OCR, no Kruti Dev table, no network). Regenerate with `node scripts/benchmark.mjs`.

**Score: 297 of 297 entries match exactly (100%).**

An entry matches when every field (serial, name, relation, relative, age, gender, house, epic) is equal;
strings are compared NFC-normalised on both sides. The decoder also found
29 struck-off serials, which the expected file leaves out.

## Mismatched entries

None: every expected entry matched.

| serial | page | field | decoded | expected |
|---:|---:|---|---|---|

## Side-by-side sample of matched entries

Page is the PDF page number, for comparison with the rendered roll.

| serial | PDF page | decoded name | expected name | decoded relative | expected relative |
|---:|---:|---|---|---|---|
| 1 | 3 | किशनादेवी | किशनादेवी | सत्यनारायण | सत्यनारायण |
| 26 | 4 | मोहन लाल | मोहन लाल | गोविन्द नारायण | गोविन्द नारायण |
| 52 | 5 | गायत्री जांगिड़ | गायत्री जांगिड़ | जितेश जांगिड़ | जितेश जांगिड़ |
| 79 | 6 | चांद देवी बैरवा | चांद देवी बैरवा | राम सहाय बैरवा | राम सहाय बैरवा |
| 106 | 7 | जगदीश | जगदीश | मोहरिया | मोहरिया |
| 133 | 8 | ममता देवी | ममता देवी | गिर्राज | गिर्राज |
| 160 | 9 | रामरूघनाथ | रामरूघनाथ | मांगीलाल | मांगीलाल |
| 187 | 10 | पांचू राम | पांचू राम | राम नारायण | राम नारायण |
| 214 | 11 | सुमन देवी | सुमन देवी | राजाराम | राजाराम |
| 241 | 12 | मोनिका जांगिड़ | मोनिका जांगिड़ | कैलाश जांगिड़ | कैलाश जांगिड़ |
| 268 | 13 | द्वारिका प्रसाद | द्वारिका प्रसाद | गजा नन्द | गजा नन्द |
| 301 | 14 | शान्ती देवी | शान्ती देवी | प्रहलाद | प्रहलाद |
| 319 | 15 | अभिषेक शर्मा | अभिषेक शर्मा | खेमराज शर्मा | खेमराज शर्मा |
