# Saved roll-page responses

Input for the catalogue generator's build stage, which runs without network
access:

```
python3 tools/sec-catalogue/build_catalogue.py --input fixtures/sec/portal-responses --out data/sec/catalogue
```

The file names are the ones the generator's fetch stage writes:

| file | response to | used for |
|---|---|---|
| `page.html` | the GET of `se_pdfdownload.aspx` | the district dropdown (all 41 districts) |
| `district-<D>.html` | the district dropdown post | the samiti / urban body dropdown |
| `samiti-<D>-<S>.html` | the samiti dropdown post | the gram panchayat dropdown |
| `search-<D>-<S>-<GP>.html` | the Search post | the ward grid (`Grampanchayat`, `Ward No.`, `Final PDF`, `Final With Supp-2 PDF`) |

The responses cover two fixture panchayats and one urban body:

- BHARATPUR (6) / NADBAI PANCHAYAT SAMITI (50) / arauda (2240): 9 wards.
- BHILWARA (7) / MANDAL PANCHAYAT SAMITI (60) / Almas (2610): 9 wards.
- JAIPUR (17) / CHAKSU NAGAR PALIKA (11473), whose third dropdown lists 35
  municipal wards. The generator skips it and counts its wards. JAIPUR's
  zilla parishad (30017), which lists nothing, is also here.

Every other district, samiti and panchayat in the dropdowns has no saved
response. The build leaves them out and counts them in its summary.

These files were not captured byte for byte: the operator runs that walked
the portal did not commit their raw bodies. They were laid out in the
documented shape of the page (`docs/research/sec-statewide-catalogue.md`,
sections 2 and 3: the hidden `__VIEWSTATE`, the three
`ctl00$ContentPlaceHolder1$…DropDown` selects and the Search grid with its
`__doPostBack` PDF links). Their contents come from what the portal returned
on those runs:

- the dropdown lists come from `data/sec/catalogue.json`;
- the ward grids come from `search_ward_rows` in `fixtures/sec/manifest.json`;
- Chaksu's 35 wards (`वार्ड क्र. 1` to `वार्ड क्र. 35`) come from section 2
  of the research doc.

Option values in Chaksu's ward dropdown and the grid's control ids are
placeholders. The view-state values are placeholders too, so these pages
cannot be replayed against the portal.
