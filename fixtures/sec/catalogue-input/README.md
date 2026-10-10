# Saved roll-page responses for the catalogue builder's tests

Test input for `tools/sec-catalogue/build_catalogue.py --input`, laid out the
way `--fetch` saves a live walk of
`https://sec.rajasthan.gov.in/se_pdfdownload.aspx`:

| file | response |
|---|---|
| `page.html` | GET of the page: the district dropdown |
| `district-<D>.html` | district selected: its samitis, urban bodies and zilla parishad |
| `samiti-<D>-<S>.html` | samiti selected: its gram panchayats (Latin) |
| `search-<D>-<S>-<G>.html` | Search: the ward grid (`Grampanchayat`, `Ward No.`, `Final PDF`, `Final With Supp-2 PDF`) |
| `cover-<S>.pdf` | ward 1's Final roll PDF of the samiti's first panchayat, read for its cover page |
| `meta.json` | when the walk started |

It covers the five panchayats with fixtures under `fixtures/sec/`: Arauda
(Bharatpur, Nadbai), Almas (Bhilwara, Mandal), Bholasar (Bikaner, Kolayat),
Ashapura (Jodhpur, Osian) and Amarpura (Udaipur, Girwa). Every ward lists a
supplementary roll (`Final With Supp-2 PDF`), Almas ward 1 included.

The raw HTML of the 2026-10-09 walks was not kept, so
`tools/sec-catalogue/make_test_input.py` rebuilds these pages from what was
committed. The dropdown ids and Latin names come from the older single-file
catalogue, `data/sec/catalogue.json` (removed by #122; the script takes a copy
through `--catalogue`).
Each Search grid (its columns, the rows' Hindi `Grampanchayat` and
`Ward No.` text, and which PDF columns link a file) comes from
`fixtures/sec/manifest.json`. The markup follows the portal's form. Each
`cover-<S>.pdf` is a byte copy of the fixture's ward 1 Final PDF. No name
here is typed by hand.

Each district page lists only its fixture samiti, plus every urban body,
zilla parishad and blank-named entry the portal lists for that district
(the build skips and counts those). Each samiti page lists only the fixture
panchayat.

Regenerate with `python3 tools/sec-catalogue/make_test_input.py`.
