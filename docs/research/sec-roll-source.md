# State Election Commission of Rajasthan: where a ward's voter roll comes from

Researched 2026-10-06 by the operator from a networked machine. Every URL in
this document was fetched successfully on that date. The commission's
servers are outside the Engineer's sandbox; this file pins what the sandbox
cannot see.

## 1. Publishing page

`https://sec.rajasthan.gov.in/se_pdfdownload.aspx` ("Download Electoral
Roll" on the commission's home page). An ASP.NET WebForms page with three
cascading dropdowns, each a postback, then a Search button:

| field | form name | value |
|---|---|---|
| district | `ctl00$ContentPlaceHolder1$DistrictDropDown` | numeric id |
| panchayat samiti or urban body | `ctl00$ContentPlaceHolder1$PSDropDown` | numeric id |
| gram panchayat or urban ward | `ctl00$ContentPlaceHolder1$GPDropDown` | numeric id |
| search | `ctl00$ContentPlaceHolder1$SearchButton` | `Search` |

No login and no captcha. Each step is a POST carrying the page's
`__VIEWSTATE` and `__EVENTVALIDATION` and the `__EVENTTARGET` of the
dropdown that changed (a scripted replay works; the page's own JavaScript
is blocked in some browsers, but the form posts still do). The Search result
is a table with one row per ward: the panchayat's Hindi name, the ward
number, and a "Final PDF" link whose postback opens the PDF URL below.

## 2. Ward PDF URL template

```
https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/<SAMITI_ID>/<PANCHAYAT_NAME>-Ward No-<NNN>.pdf
```

- `SAMITI_ID` is the panchayat samiti's numeric id from the second dropdown.
- `PANCHAYAT_NAME` is the gram panchayat's name as the portal spells it in
  Latin letters, upper-cased (dropdown text `Badli` becomes `BADLI`). The
  space in `Ward No` is literal (`%20` when encoded).
- `NNN` is the ward number zero-padded to three digits.
- `PRI` is the rural tier; `Final` is the final roll. Urban bodies were not
  checked and may use a different tier segment.
- The PDF URL is a plain GET: no cookie, no session, no form, no captcha.
  A ward number that does not exist answers `302` to an HTML error page
  (173 bytes), so the ward count of a panchayat can be probed by number.

## 3. Path to Badli gram panchayat

| level | id | portal text (Latin) | Hindi name on the roll |
|---|---|---|---|
| district | 17 | JAIPUR | जयपुर |
| panchayat samiti | 125 | CHAKSU PANCHAYAT SAMITI | चाकसू |
| gram panchayat | 6313 | Badli | बडली |

Zilla parishad constituency 34, panchayat samiti constituency 8, assembly
segment 58-Chaksu, as printed on the roll's cover.

## 4. Badli's wards

Seven wards, each labelled `बडली` with its number in the search result.

| ward | PDF URL | size (bytes) |
|---|---|---|
| 1 | https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf | 257132 |
| 2 | https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-002.pdf | 282005 |
| 3 | https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-003.pdf | 272208 |
| 4 | https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-004.pdf | 275780 |
| 5 | https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-005.pdf | 257034 |
| 6 | https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-006.pdf | 249363 |
| 7 | https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-007.pdf | 256832 |

Ward 1 is committed as `fixtures/badli-ward1.pdf`. All seven are text-layer
PDFs produced by iTextSharp 4.0.6 with embedded Arial Unicode MS subsets,
not scans; see `tools/reference-decoder/README.md`.

## 5. CORS and transport

Response headers of the ward 1 PDF, fetched with
`Origin: https://canvass.takshavid.com` on 2026-10-06:

```
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Length: 257132
Last-Modified: Mon, 23 Feb 2026 03:54:16 GMT
Server: Microsoft-IIS/8.5
X-Content-Type-Options: nosniff
```

There is no `Access-Control-Allow-Origin` header, and an `OPTIONS` preflight
answers `302`. A browser on the candidate's domain therefore cannot fetch
the PDF directly; the PWA needs a same-origin relay (a server that fetches
the PDF and returns it, or returns the decoded roll). No cookie, captcha or
form is needed for the PDF itself.

## 6. Catalogue data for the picker

The portal is the only source of ids. The 41 districts and their ids:
AJMER (1), ALWAR (2), BALOTRA (34), BANSWARA (3), BARAN (4), BARMER (5), BEAWAR (35), BHARATPUR (6), BHILWARA (7), BIKANER (8), BUNDI (9), CHITTORGARH (10), CHURU (11), DAUSA (12), DEEDWANA-KUCHAMAN (36), DEEG (37), DHOLPUR (13), DUNGARPUR (14), GANGANAGAR (15), HANUMANGARH (16), JAIPUR (17), JAISALMER (18), JALORE (19), JHALAWAR (20), JHUNJHUNU (21), JODHPUR (22), KARAULI (23), KHAIRTHAL-TIJARA (38), KOTA (24), KOTPUTLI-BEHROR (39), NAGAUR (25), PALI (26), PHALODI (40), PRATAPGARH (27), RAJSAMAND (28), S. MADHOPUR (29), SALUMBER (41), SIKAR (30), SIROHI (31), TONK (32), UDAIPUR (33).

Jaipur district's samitis and urban bodies (dropdown id, portal text):

| id | name |
|---|---|
| 459 | AMARSAR PANCHAYAT SAMITI |
| 123 | AMBER PANCHAYAT SAMITI |
| 315 | ANDHI PANCHAYAT SAMITI |
| 11472 | BAGRU NAGAR PALIKA |
| 11552 | BASSI NAGAR PALIKA |
| 124 | BASSI PANCHAYAT SAMITI |
| 11473 | CHAKSU NAGAR PALIKA |
| 125 | CHAKSU PANCHAYAT SAMITI |
| 11474 | CHOMU NAGAR PARISHAD |
| 398 | CHOMU PANCHAYAT SAMITI |
| 12042 | DUDU NAGAR PALIKA |
| 126 | DUDU PANCHAYAT SAMITI |
| 127 | GOVINDGARH PANCHAYAT SAMITI |
| 10019 | JAIPUR NAGAR NIGAM |
| 30017 | JAIPUR ZILLA PARISHAD ZILLA PARISHAD |
| 275 | JALSU PANCHAYAT SAMITI |
| 128 | JAMWA RAMGARH PANCHAYAT SAMITI |
| 12041 | JAMWARAMGARH NAGAR PALIKA |
| 129 | JHOTWARA PANCHAYAT SAMITI |
| 11475 | JOBNER NAGAR PALIKA |
| 316 | JOBNER PANCHAYAT SAMITI |
| 12038 | KALADERA NAGAR PALIKA |
| 12043 | KANOTA NAGAR PALIKA |
| 12036 | KHEJROLI NAGAR PALIKA |
| 11476 | KISHANGARH RENWAL NAGAR PALIKA |
| 317 | KISHANGARH RENWAL PANCHAYAT SAMITI |
| 346 | KOTKHAWADA PANCHAYAT SAMITI |
| 318 | MADHORAJPURA PANCHAYAT SAMITI |
| 12039 | MANOHARPUR NAGAR PALIKA |
| 319 | MAUZAMABAD PANCHAYAT SAMITI |
| 12035 | NARAYANA NAGAR PALIKA |
| 12037 | PHAGI NAGAR PALIKA |
| 131 | PHAGI PANCHAYAT SAMITI |
| 11478 | PHULERA NAGAR PALIKA |
| 399 | RAMPURA DABARI PANCHAYAT SAMITI |
| 11479 | SAMBHAR NAGAR PALIKA |
| 133 | SAMBHAR PANCHAYAT SAMITI |
| 134 | SANGANER PANCHAYAT SAMITI |
| 11480 | SHAHPURA NAGAR PARISHAD |
| 132 | SHAHPURA PANCHAYAT SAMITI |
| 320 | TUNGA PANCHAYAT SAMITI |
| 12040 | VATIKA NAGAR PALIKA |

Chaksu panchayat samiti's gram panchayats (dropdown id, portal text):

| id | name |
|---|---|
| 14642 | akodiya |
| 6313 | Badli |
| 14639 | Ballupura |
| 6314 | Barkhera |
| 6315 | Bhojyada |
| 14640 | Chandel kala |
| 6316 | Chandlai |
| 6317 | Dahar |
| 6318 | Dhunsari-Rupwas Mukhayalya Dhunsari |
| 6319 | Girdharilalpura |
| 6339 | Jagat shiromanipura urf Toomli Ka Bas |
| 6320 | Kadera |
| 6312 | Kalyanpura |
| 6321 | Kareda Khurd |
| 6322 | Khejadi Bujurg |
| 6323 | Kilakipura |
| 6324 | Kothoon |
| 6325 | Kumhariyawas |
| 6326 | Lakshmipura Urf Kathavala |
| 6327 | Maksoodanpura URF Bara Padampura |
| 6328 | Nimodiya |
| 6329 | Ramniwas pura |
| 6330 | Sanwaliya |
| 6331 | Sawai Madhosinghpura |
| 6332 | Seemliyawas Vatika |
| 6333 | Shivdaspura |
| 6334 | Surajpura URF Tootoli |
| 6335 | Tamariya |
| 6336 | Teetriya |
| 6337 | Thali |
| 6338 | Tigariya |
| 14641 | Udaipuriya |

A full state catalogue (district, samiti, panchayat, ward count) can be built
by replaying the three postbacks per panchayat and probing ward numbers
against the PDF URL; it needs network access and is operator work.

relay-required
