#!/usr/bin/env python3
"""Write fixtures/sec/catalogue-input/: a small directory of saved roll-page
responses, in the layout build_catalogue.py --fetch saves, for the five
panchayats that already have fixtures under fixtures/sec/.

The raw HTML of the 2026-10-09 walks was not committed, so the pages are
rebuilt from what was: the dropdown entries (ids, Latin names) come from
the older single-file catalogue (data/sec/catalogue.json until #122 removed
it; pass a copy, e.g. `git show 6936b45:data/sec/catalogue.json`, or a
build_catalogue.py --legacy-out file), and each Search grid (its columns, its rows'
Grampanchayat and Ward No. text, which PDF columns link a file) from
fixtures/sec/manifest.json. The markup follows the portal's form (the field
names build_catalogue.py posts, hidden __VIEWSTATE / __EVENTVALIDATION, a
postback link in each PDF cell). Each samiti's cover-<S>.pdf is a byte copy
of the fixture ward 1 Final PDF.

Each district page lists its one fixture samiti plus every urban body, zilla
parishad and blank-named entry the portal lists for the district, so the
build's skip counts are exercised; other rural samitis and panchayats are
left out. No name in the output is typed by hand.

    python3 tools/sec-catalogue/make_test_input.py --catalogue OLDER_CATALOGUE.json
"""

import argparse
import html
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_catalogue import (  # noqa: E402 - the sibling module is found via the line above
    DISTRICT_FIELD,
    GP_FIELD,
    PS_FIELD,
    SCHEMA_VERSION,
    SEARCH_FIELD,
    SOURCE_PAGE,
    META_FILE,
    PAGE_FILE,
    cover_file,
    district_file,
    entry_kind,
    samiti_file,
    search_file,
)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


def _select(field, placeholder, options, selected):
    out = [f'<select name="{html.escape(field)}" id="{html.escape(field.replace("$", "_"))}">',
           f'<option value="0">{html.escape(placeholder)}</option>']
    for value, text in options:
        sel = ' selected="selected"' if value == selected else ""
        out.append(f'<option{sel} value="{html.escape(value)}">{html.escape(text)}</option>')
    out.append("</select>")
    return "\n".join(out)


def form_page(name, districts, did=None, samitis=(), sid=None, gps=(), gp=None, grid=""):
    return "\n".join([
        "<!DOCTYPE html>",
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8" />'
        "<title>PDF Download</title></head><body>",
        '<form method="post" action="./se_pdfdownload.aspx" id="form1">',
        f'<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="fixture-{name}" />',
        '<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" '
        'value="fixture" />',
        f'<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" '
        f'value="fixture-{name}" />',
        _select(DISTRICT_FIELD, "--Select District--", districts, did),
        _select(PS_FIELD, "--Select ULB/PanchayatSamiti--", samitis, sid),
        _select(GP_FIELD, "--Select--", gps, gp),
        f'<input type="submit" name="{SEARCH_FIELD}" value="Search" />',
        grid,
        "</form></body></html>",
        "",
    ])


def grid_html(columns, rows, linked):
    out = ['<table cellspacing="0" rules="all" border="1" id="ContentPlaceHolder1_GridView1">',
           "<tr>" + "".join(f'<th scope="col">{html.escape(c)}</th>' for c in columns) + "</tr>"]
    for i, row in enumerate(rows):
        cells = []
        for col, text in zip(columns, row):
            if col in linked:
                target = f"ctl00$ContentPlaceHolder1$GridView1$ctl{i + 2:02d}${linked[col]}"
                cells.append(f"<td><a href=\"javascript:__doPostBack('{target}','')\">"
                             '<img src="images/pdf.png" alt="" /></a></td>')
            else:
                cells.append(f"<td>{html.escape(text)}</td>")
        out.append("<tr>" + "".join(cells) + "</tr>")
    out.append("</table>")
    return "\n".join(out)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--catalogue", required=True,
                   help="the older single-file catalogue (dropdown ids and Latin names)")
    args = p.parse_args(argv)
    out_dir = os.path.join(REPO, "fixtures", "sec", "catalogue-input")
    with open(os.path.join(REPO, "fixtures", "sec", "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    with open(args.catalogue, encoding="utf-8") as fh:
        catalogue = json.load(fh)
    picks = {p["district"]["id"]: p for p in manifest["panchayats"]}
    portal = [d for d in catalogue["districts"] if d["id"] in picks]
    districts = [(d["id"], d["name"]) for d in portal]
    os.makedirs(out_dir, exist_ok=True)

    def write(name, text):
        with open(os.path.join(out_dir, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)

    write(META_FILE, json.dumps({
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE_PAGE,
        "fetchedAt": manifest["generated_at"],
        "note": "Test input rebuilt by tools/sec-catalogue/make_test_input.py from "
                "fixtures/sec/manifest.json and data/sec/catalogue.json; see README.md.",
    }, ensure_ascii=False, indent=1) + "\n")
    write(PAGE_FILE, form_page("page", districts))
    for d in portal:
        p = picks[d["id"]]
        did, sid, gp = d["id"], p["samiti"]["id"], p["panchayat"]["id"]
        samitis = [(s["id"], s["name"]) for s in d["samitis"]
                   if s["id"] == sid or entry_kind(s["name"]) != "rural"]
        gps = [(gp, p["panchayat"]["name"])]
        write(district_file(did), form_page(f"district-{did}", districts, did, samitis))
        write(samiti_file(did, sid), form_page(f"samiti-{did}-{sid}", districts, did, samitis,
                                               sid, gps))
        linked = {c: ("lnkFinal" if c == "Final PDF" else "lnkSupp")
                  for c in p["pdf_columns"]}
        grid = grid_html(p["search_columns"], p["search_ward_rows"], linked)
        write(search_file(did, sid, gp), form_page(f"search-{did}-{sid}-{gp}", districts, did,
                                                   samitis, sid, gps, gp, grid))
        ward1 = next(f for f in p["files"] if f["column"] == "Final PDF" and f["ward"] == 1)
        shutil.copyfile(os.path.join(REPO, ward1["path"]), os.path.join(out_dir, cover_file(sid)))
        print(f"{d['name']}: {len(samitis)} dropdown entries, {p['panchayat']['name']} "
              f"({len(p['search_ward_rows'])} wards, columns {sorted(linked)})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
