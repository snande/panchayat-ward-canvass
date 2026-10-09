# State Election Commission of Rajasthan: statewide catalogue and five-district roll fixtures

Fetched 2026-10-09 between 12:08 and 12:22 UTC by the operator, from a
networked machine, with the scripts in `tools/sec-catalogue/`. This extends
`docs/research/sec-roll-source.md`, which documents the portal and Badli; read
that first. Nothing here changes the app, the relay or
`config/constituency.json`.

## 1. What was fetched

| file | what it is |
|---|---|
| `data/sec/catalogue.json` | every district and every entry of the second dropdown (panchayat samitis, urban bodies, zilla parishads), with portal ids. Gram panchayat lists were not fetched; see section 2. |
| `fixtures/sec/<district>/<PANCHAYAT>-ward-<NNN>.pdf` | the Final PDF of every ward of five gram panchayats in five districts |
| `fixtures/sec/<district>/<PANCHAYAT>-ward-<NNN>-supp-2.pdf` | the "Final With Supp-2 PDF" of the same wards, where the server has one |
| `fixtures/sec/manifest.json` | for every file: source URL, fetch time, size, SHA-256 and the server's Last-Modified; for every panchayat: the ward grid the portal's Search listed and the ward number that first answered a redirect |

77 PDFs, 24,744,894 bytes in all. Every PDF is stored byte for byte as
served.

Sources, and only these: `https://sec.rajasthan.gov.in/se_pdfdownload.aspx`
(the roll page's form posts, plus one read of `robots.txt`, which does not
disallow the page) and `https://esuchiroll.rajasthan.gov.in` (the PDFs).
Every request carried the User-Agent
`takshavid-canvass-catalogue/1.0 (operator data staging)`, and the scripts
wait at least one second after each response before the next request to the
same host.

| host | requests | detail |
|---|---|---|
| sec.rajasthan.gov.in | 88 | 80 form posts, 8 GETs (7 of the page, 1 of `robots.txt`) |
| esuchiroll.rajasthan.gov.in | 87 | 77 PDFs (HTTP 200) and 10 missing-ward probes (HTTP 302) |
| canvass.takshavid.com | 3 | the two relay checks in section 6, and one HEAD of `/fixtures/README.md` |

There were no errors, retries, 403s or 429s, and no captcha or challenge
page. Of the 80 posts, 41 walked the districts, 28 fetched the five fixture
panchayats (three of them Searches of panchayats skipped for size), 4 were an
exploratory pass over Jaipur (which re-confirmed the Jaipur samiti list and
Chaksu's 32 gram panchayats in `sec-roll-source.md` exactly), and 7 were two
fixture attempts that stopped early while the script's reading of the Search
result was fixed.

## 2. The catalogue, and why it has no gram panchayats yet

The second dropdown ("ULB/PanchayatSamiti") lists 817 entries across the 41
districts:

- 457 rural panchayat samitis (every name ends in `PANCHAYAT SAMITI`);
- 309 urban bodies: 252 `NAGAR PALIKA`, 47 `NAGAR PARISHAD`, 10 `NAGAR NIGAM`;
- 41 zilla parishads, one per district, named like `JAIPUR ZILLA PARISHAD ZILLA PARISHAD`;
- 10 entries whose dropdown text is empty (ids 10029, 10053, 10054, 10055,
  11423, 11439, 11440, 11450, 11558, 11559).

`kind` is `rural` for the samitis, `urban` for the urban bodies, and
`unknown` for the zilla parishads and the blank entries.

Gram panchayats come from the third dropdown, one form post per samiti. The
approval for this run was about 400 posts, with a stop after districts and
samitis if the walk needed materially more than about 450. Walking the 457
rural samitis needs 498 posts (one per samiti, plus one district post per
district to get that district's form state), so the script stopped after the
district pass as instructed and wrote every samiti with an empty
`panchayats` list. The catalogue's own `notes` say so. The 457 is well above
the roughly 350 samitis Rajasthan is often cited as having; the portal's list
follows the current 41-district map and its newer samitis.

Finishing it is a re-run with a higher cap, which costs 498 posts at about
1.2 seconds each (roughly ten minutes):

```
python3 tools/sec-catalogue/build_catalogue.py --max-posts 520 --checkpoint /tmp/sec-checkpoint.json
```

`--checkpoint` lets an interrupted run resume without repeating finished
samitis. Ward lists are deliberately never fetched by the catalogue: posting
Search for every gram panchayat would be over ten thousand posts. A ward list
is found at use time by requesting ward 001, 002, ... from the URL template
until one answers 302 (section 3).

What the third dropdown holds for the other kinds, seen once each in Jaipur:
an urban body lists its municipal wards in Hindi (`CHAKSU NAGAR PALIKA`, id
11473: 35 entries `वार्ड क्र. 1` to `वार्ड क्र. 35`), and a zilla parishad
lists nothing (`JAIPUR ZILLA PARISHAD ZILLA PARISHAD`, id 30017). The
catalogue walks neither.

Districts, with the count of each kind of second-dropdown entry:

| id | district | panchayat samitis | urban bodies | zilla parishad | blank |
|---|---|---|---|---|---|
| 1 | AJMER | 10 | 9 | 1 | 0 |
| 2 | ALWAR | 11 | 12 | 1 | 0 |
| 34 | BALOTRA | 11 | 7 | 1 | 0 |
| 3 | BANSWARA | 16 | 3 | 1 | 0 |
| 4 | BARAN | 10 | 6 | 1 | 0 |
| 5 | BARMER | 17 | 2 | 1 | 0 |
| 35 | BEAWAR | 7 | 5 | 1 | 0 |
| 6 | BHARATPUR | 7 | 7 | 1 | 1 |
| 7 | BHILWARA | 16 | 11 | 1 | 0 |
| 8 | BIKANER | 15 | 7 | 1 | 0 |
| 9 | BUNDI | 8 | 8 | 1 | 1 |
| 10 | CHITTORGARH | 11 | 7 | 1 | 1 |
| 11 | CHURU | 13 | 11 | 1 | 1 |
| 12 | DAUSA | 14 | 11 | 1 | 0 |
| 36 | DEEDWANA-KUCHAMAN | 9 | 8 | 1 | 0 |
| 37 | DEEG | 5 | 6 | 1 | 0 |
| 13 | DHOLPUR | 6 | 7 | 1 | 0 |
| 14 | DUNGARPUR | 14 | 2 | 1 | 0 |
| 15 | GANGANAGAR | 11 | 11 | 1 | 1 |
| 16 | HANUMANGARH | 10 | 8 | 1 | 0 |
| 17 | JAIPUR | 22 | 19 | 1 | 1 |
| 18 | JAISALMER | 10 | 2 | 1 | 0 |
| 19 | JALORE | 14 | 5 | 1 | 0 |
| 20 | JHALAWAR | 8 | 8 | 1 | 0 |
| 21 | JHUNJHUNU | 14 | 19 | 1 | 0 |
| 22 | JODHPUR | 23 | 7 | 1 | 1 |
| 23 | KARAULI | 11 | 6 | 1 | 0 |
| 38 | KHAIRTHAL-TIJARA | 6 | 7 | 1 | 0 |
| 24 | KOTA | 6 | 6 | 1 | 2 |
| 39 | KOTPUTLI-BEHROR | 8 | 9 | 1 | 0 |
| 25 | NAGAUR | 12 | 9 | 1 | 0 |
| 26 | PALI | 9 | 10 | 1 | 0 |
| 40 | PHALODI | 9 | 2 | 1 | 0 |
| 27 | PRATAPGARH | 8 | 4 | 1 | 0 |
| 28 | RAJSAMAND | 9 | 5 | 1 | 0 |
| 29 | S. MADHOPUR | 8 | 6 | 1 | 0 |
| 41 | SALUMBER | 7 | 1 | 1 | 0 |
| 30 | SIKAR | 16 | 14 | 1 | 0 |
| 31 | SIROHI | 8 | 6 | 1 | 1 |
| 32 | TONK | 8 | 10 | 1 | 0 |
| 33 | UDAIPUR | 20 | 6 | 1 | 0 |

## 3. URL templates

The Search result is a grid with four columns: `Grampanchayat` (the Hindi
name), `Ward No.`, `Final PDF` and `Final With Supp-2 PDF`. The two PDF
columns are image links whose postback answers with the roll page plus a
script, `window.open('<url>','_newtab')`, naming the PDF. Clicking each
column's link for ward 1 of each fixture panchayat gave two templates:

```
https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/<SAMITI_ID>/<PANCHAYAT_NAME>-Ward%20No-<NNN>.pdf
https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Supplement/<SAMITI_ID>/<PANCHAYAT_NAME>-Ward%20No-<NNN>.pdf
```

The first is the template in `sec-roll-source.md` section 2, confirmed in
five more samitis. The portal writes the space in `Ward No` literally; it
must be sent as `%20`. `PANCHAYAT_NAME` is the dropdown text upper-cased.
A ward that does not exist answers `302` with
`Location: https://esuchiroll.rajasthan.gov.in/ErrorPage.aspx` (the scripts
do not follow it). For the Final column of every fixture panchayat the
probe's first 302 came exactly one past the number of rows Search listed, so
probing by number and reading the grid agree.

## 4. The five fixture panchayats

Each is a rural gram panchayat, one per district, the first in its samiti's
dropdown with a one-word name and at most nine wards (to keep the total under
25 MB once the Supp-2 PDFs turned out to exist). Akkasar (Kolayat), Ainchera
and Akhaigarh (Nadbai) were searched first and skipped at 11 wards each.

| district | panchayat samiti (id) | gram panchayat (id) | Hindi name | wards | Final PDF | Final With Supp-2 PDF | total |
|---|---|---|---|---|---|---|---|
| BHILWARA | MANDAL (60) | Almas (2610) | आलमास | 9 | 9 files, 1.83 MB | 9 files, 2.54 MB | 4.37 MB |
| UDAIPUR | GIRWA (240) | Amarpura (11913) | अमरपुरा | 9 | 9 files, 2.88 MB | 9 files, 3.50 MB | 6.38 MB |
| JODHPUR | OSIAN (168) | Ashapura (8425) | आशापुरा | 7 | 7 files, 2.27 MB | 7 files, 2.80 MB | 5.07 MB |
| BIKANER | KOLAYAT (69) | BHOLASAR (3044) | भोलासर | 9 | 9 files, 2.74 MB | 9 files, 3.33 MB | 6.07 MB |
| BHARATPUR | NADBAI (50) | arauda (2240) | अरौदा | 9 | 9 files, 2.86 MB | none: the link is listed but the file answers 302 | 2.86 MB |

To fetch them again (it re-downloads and rewrites the manifest entries):

```
python3 tools/sec-catalogue/fetch_fixtures.py --pick 7:60:2610 --pick 33:240:11913 \
    --pick 22:168:8425 --pick 8:69:3044 --pick 6:50:2240
```

A pick is `DISTRICT:SAMITI[:GP,...]` by portal id; each costs one GET of the
page per run, then two posts to reach the samiti, one Search post, and one
post per PDF column to learn the column's URL. The PDFs are plain GETs.

## 5. What is inside the PDFs

All 77 are text-layer PDFs from the same generator as Badli's (`iTextSharp
4.0.6 (based on iText 2.0.6)`), with the same struck-off legend (`E-Deleted
Due To Death | S-Deleted Due To Shifted | R-Deleted Due to Repeatition`) and
the same `(I+II-III)` summary formula, so the decoder's layout assumptions
should carry over. That is a reading of the raw content streams only; the
new files were not run through a decoder (the reference decoder needs
`pypdf` and `fontTools`, which were not installed for this run, and the
machine had no Node.js for `src/decoder`).

The Final PDFs carry Last-Modified dates of 24 February 2026 (25 February for
Arauda), matching Badli's 23 February. In 37 of the 43 Final files some
EPIC numbers are printed twice, which in Badli's roll is the mark of a
struck-off entry repeated in the deletion list.

The Supp-2 PDFs are new: their Last-Modified dates are 7 October 2026
(Amarpura) and 8 October 2026 (Almas, Ashapura, Bholasar), one or two days
before this run. Each is two or three pages longer than the same ward's
Final file.
No EPIC number in the Final file is missing from the Supp-2 file, and in 13
of the 34 wards some EPIC numbers are printed more often in Supp-2 than in
Final, which reads as further struck-off entries in a second supplement's
deletion list. New entries in these rolls carry no EPIC (Badli's supplement
entries have none), so additions cannot be counted this way. This is a
tentative reading pending a decoder run; it would be falsified by decoding a
Supp-2 file and finding no additional supplement section.

## 6. The /roll relay

`GET /roll?url=<encodeURIComponent(pdfUrl)>` on `canvass.takshavid.com`, the
request shape `src/roll/fetchRoll.js` sends:

| request | status | body | meaning |
|---|---|---|---|
| Almas ward 1 Final PDF (`.../Final/60/ALMAS-Ward%20No-001.pdf`) | 403 | `url not in the constituency config` | the relay's allowlist is the ward `pdfUrl` set of `config/constituency.json`, which holds only Badli's seven wards; it refused without contacting the SEC server, as designed |
| Badli ward 1 Final PDF (control) | 200 | 257,132 bytes, `application/pdf` | the relay is live on Cloudflare Pages and can reach the SEC server; the bytes are identical to `fixtures/badli-ward1.pdf` (SHA-256 `d0f17af7...67b48f`) |

So the relay works, and serving any other panchayat needs its wards added to
`config/constituency.json` (or a different allowlist rule); a statewide
picker built on this catalogue would hit the 403 for every ward outside
Badli. The relay was not changed.

## 7. Things worth knowing

- The roll now has a newer version than the one the app reads. The app's
  `pdfUrl`s are the Final column; the Supp-2 column was published on 7 and 8
  October 2026 for four of the five fixture panchayats. Badli's own Supp-2
  file was not requested (Badli was outside this run's approval); if it
  exists, the app is reading a superseded roll.
- Supp-2 is not yet everywhere. Arauda (Bharatpur) lists the Supp-2 link in
  every ward row, but ward 1's file answers 302. A link in the grid does not
  mean the file exists.
- The second dropdown is not only samitis: urban bodies, zilla parishads and
  ten blank-named entries are mixed in, sorted alphabetically together. Any
  picker built on it should filter on `kind`.
- Dropdown spelling is inconsistent in case: `Almas`, `Amarpura`,
  `BHOLASAR`, `AKKASAR`, `arauda`, `akodiya`. The URL uses the upper-cased
  form either way. Some names carry spaces or hyphens
  (`Dhunsari-Rupwas Mukhayalya Dhunsari` in Chaksu), which go into the URL
  percent-encoded.
- The page's dropdowns have no `onchange` handler in the served HTML and
  there is no `__EVENTTARGET` hidden field; a replayed post carrying the new
  selection and the previous `__VIEWSTATE` and `__EVENTVALIDATION` is enough.
  The server sets an `ASP.NET_SessionId` and an `__AntiXsrfToken` cookie on
  the first GET, so the scripts keep a cookie jar for the run.
- The fixture PDFs sit under the repository root, which Cloudflare Pages
  serves as static files (`/fixtures/README.md` answers 200 on
  `canvass.takshavid.com`), so once merged they are publicly downloadable
  from the candidate's domain, as `fixtures/badli-ward1.pdf` already is.

## 8. Running the scripts

Both scripts are standard-library Python 3 (tested with 3.9) and must run
from a networked machine: the swarm's Engineer sandbox cannot reach the
commission's servers. Each stops at once on a 403, 429, an unexpected
redirect, or a response that is not the roll form, and backs off
exponentially (2, 4, 8, 16 s) on network errors and 5xx before stopping.
Neither accepts an `--interval` below one second. `--log FILE` appends one
JSON line per request; `--raw-dir DIR` keeps every response body for
inspection.
