#!/usr/bin/env python3
"""Download every ward roll PDF of a few chosen gram panchayats into
fixtures/sec/ and record them in fixtures/sec/manifest.json.

For each pick the roll page is walked to the samiti (two posts) and Search
is posted for one gram panchayat. The result lists one row per ward with a
link per published PDF column ("Final PDF", "Final With Supp-2 PDF"). Each
column's link is clicked for the first ward only (one post per column) to
learn where that column's PDFs live; every ward's PDF is then fetched by
plain GET from that location with the ward number changed, ward 001 upward,
stopping at the first ward that answers 302 (the missing-ward error page).
Same politeness rules and client as build_catalogue.py.

    python3 tools/sec-catalogue/fetch_fixtures.py --pick 7:60:2610 --pick 33:240

A pick is DISTRICT:SAMITI[:GP,...] by portal id. Without GP ids the samiti's
panchayats with a one-word Latin name are tried in dropdown order. A
panchayat whose Search lists more than --max-wards wards is skipped for the
next candidate (one more Search post each, at most --max-tries per pick).
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_catalogue import (  # noqa: E402 - the sibling module is found via the line above
    DISTRICT_FIELD,
    FINAL_COLUMN,
    GP_FIELD,
    PS_FIELD,
    SOURCE_PAGE,
    Blocked,
    PoliteClient,
    RollForm,
    UnexpectedResponse,
    district_slug,
    now_iso,
    result_grid,
)

# The portal's PDF paths carry a literal space ("Ward No-001.pdf").
_PDF_URL_RE = re.compile(r"https?://[^'\"<>\r\n]+?\.pdf", re.I)
_WARD_IN_URL_RE = re.compile(r"-(\d{3})\.pdf$", re.I)


def district_dir(name):
    return district_slug(name)


def column_suffix(header):
    """File-name suffix for a PDF column: '' for Final PDF, else e.g. '-supp-2'."""
    if header == FINAL_COLUMN:
        return ""
    m = re.search(r"supp\w*[-\s]*(\d+)", header, re.I)
    return f"-supp-{m.group(1)}" if m else "-" + re.sub(r"[^a-z0-9]+", "-", header.lower()).strip("-")


def _candidates(samiti_page, gps, max_tries):
    options = samiti_page.options(GP_FIELD)
    names = dict(options)
    if gps:
        missing = [g for g in gps if g not in names]
        if missing:
            raise SystemExit(f"GP ids {missing} are not in the samiti's dropdown")
        return [(g, names[g]) for g in gps][:max_tries]
    simple = [(v, t) for v, t in options if re.fullmatch(r"[A-Za-z]+", t)]
    return simple[:max_tries]


def resolve(form, result, did, sid, gp, target, raw_dir=None):
    """Click one PDF link; return (pdf url, how it arrived)."""
    status, headers, body = form.click(result, did, sid, gp, target)
    if raw_dir:
        name = re.sub(r"[^A-Za-z0-9]+", "-", target).strip("-")
        with open(os.path.join(raw_dir, f"click-{did}-{sid}-{gp}-{name}.html"), "wb") as fh:
            fh.write(f"HTTP {status}\n{headers}\n\n".encode("utf-8") + body)
    url, how = None, None
    if 300 <= status < 400 and headers.get("Location"):
        url, how = urllib.parse.urljoin(SOURCE_PAGE, headers["Location"]), f"redirect {status}"
    elif status == 200:
        m = _PDF_URL_RE.search(body.decode("utf-8", errors="replace"))
        if m:
            url, how = m.group(0).replace("&amp;", "&"), "url in page"
    if url:
        return urllib.parse.quote(url, safe=":/%?=&"), how
    raise UnexpectedResponse(f"link {target}: HTTP {status}, no PDF location found")


def fetch_pick(client, form, page0, pick, args, budget):
    did, sid, gps = pick
    dname = dict(page0.options(DISTRICT_FIELD))[did]
    district_page, _raw = form.select_district(page0, did)
    sname = dict(district_page.options(PS_FIELD))[sid]
    samiti_page, _raw = form.select_samiti(district_page, did, sid)
    chosen = None
    for gp, gname in _candidates(samiti_page, gps, args.max_tries):
        result, raw = form.search(samiti_page, did, sid, gp)
        if args.raw_dir:
            os.makedirs(args.raw_dir, exist_ok=True)
            with open(os.path.join(args.raw_dir, f"search-{did}-{sid}-{gp}.html"), "wb") as fh:
                fh.write(raw)
        headers, rows = result_grid(result)
        print(f"  search {gname} ({gp}): {len(rows)} ward rows, columns {headers}", file=sys.stderr)
        if not rows:
            raise UnexpectedResponse(f"search {gp}: no ward rows found in the result")
        if len(rows) <= args.max_wards:
            chosen = (gp, gname, result, headers, rows)
            break
    if chosen is None:
        print(f"  {dname} / {sname}: no candidate had at most {args.max_wards} wards",
              file=sys.stderr)
        return None

    gp, gname, result, headers, rows = chosen
    columns = [h for h in headers if any(h in r["links"] for r in rows)]
    entry = {
        "district": {"id": did, "name": dname},
        "samiti": {"id": sid, "name": sname},
        "panchayat": {"id": gp, "name": gname},
        "search_columns": headers,
        "search_ward_rows": [r["cells"] for r in rows],
        "pdf_columns": {},
        "files": [],
    }
    out_dir = os.path.join(args.out_dir, district_dir(dname))
    os.makedirs(out_dir, exist_ok=True)
    upper = gname.upper()
    for column in columns:
        first = rows[0]
        url1, how = resolve(form, result, did, sid, gp, first["links"][column], args.raw_dir)
        m = _WARD_IN_URL_RE.search(url1)
        if not m or int(m.group(1)) != first["ward"]:
            raise UnexpectedResponse(f"{column}: {url1} does not end in the ward number")
        template = url1[:m.start(1)] + "{ward:03d}" + url1[m.end(1):]
        info = {"ward_1_link_resolved_to": url1, "resolved_by": how,
                "url_template": template.replace("{ward:03d}", "{NNN}")}
        entry["pdf_columns"][column] = info
        print(f"  {column}: {url1} ({how})", file=sys.stderr)
        ward = 0
        while True:
            ward += 1
            url = template.format(ward=ward)
            fetched = now_iso()
            status, resp_headers, body = client.request(url, accept_redirect=True)
            if 300 <= status < 400:
                info["first_missing_ward"] = {"ward": ward, "status": status,
                                              "location": resp_headers.get("Location"),
                                              "fetched_at": fetched}
                break
            if status != 200 or not body.startswith(b"%PDF-"):
                raise UnexpectedResponse(f"{url}: HTTP {status}, {len(body)} bytes, not a PDF")
            budget["bytes"] += len(body)
            if budget["bytes"] > args.max_total_mb * 1024 * 1024:
                raise UnexpectedResponse(f"over the {args.max_total_mb:g} MB budget at {url}")
            path = os.path.join(out_dir, f"{upper}-ward-{ward:03d}{column_suffix(column)}.pdf")
            with open(path, "wb") as fh:
                fh.write(body)
            entry["files"].append({
                "path": os.path.relpath(path, args.repo).replace(os.sep, "/"),
                "column": column,
                "ward": ward,
                "url": url,
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
                "fetched_at": fetched,
                "last_modified": resp_headers.get("Last-Modified"),
            })
            print(f"    ward {ward:03d}: {len(body)} bytes", file=sys.stderr)
            if ward >= len(rows) + 3:
                raise UnexpectedResponse(f"{url}: more PDFs than the {len(rows)} rows Search listed")
        info["ward_count"] = sum(1 for f in entry["files"] if f["column"] == column)
    entry["ward_count"] = len(rows)
    entry["bytes"] = sum(f["bytes"] for f in entry["files"])
    for column, info in entry["pdf_columns"].items():
        if info["ward_count"] != len(rows):
            print(f"  NOTE: {column}: {len(rows)} ward rows listed but {info['ward_count']} "
                  f"PDFs found", file=sys.stderr)
    return entry


def write_manifest(path, entries):
    manifest = {
        "generated_at": now_iso(),
        "source_page": SOURCE_PAGE,
        "notes": [
            "Ward roll PDFs of the State Election Commission of Rajasthan's 2026 panchayat "
            "roll (PRI tier), stored byte for byte as served.",
            "search_columns and search_ward_rows are the grid the roll page's Search listed "
            "for the panchayat. Each PDF column's link was clicked for ward 1 only "
            "(pdf_columns.*.ward_1_link_resolved_to); the other wards were fetched from "
            "url_template by number, from 001 upward, and first_missing_ward is the first "
            "number that answered a redirect instead of a PDF.",
            "File names: <PANCHAYAT>-ward-<NNN>.pdf is the Final PDF column; a -supp-<n> "
            "suffix marks the 'Final With Supp-<n> PDF' column.",
        ],
        "total_files": sum(len(e["files"]) for e in entries),
        "total_bytes": sum(e["bytes"] for e in entries),
        "panchayats": entries,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
        fh.write("\n")


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--pick", action="append", required=True, help="DISTRICT:SAMITI[:GP,...]")
    p.add_argument("--out-dir", default=os.path.join(repo, "fixtures", "sec"))
    p.add_argument("--manifest", help="default: <out-dir>/manifest.json; an existing one is "
                                      "extended, replacing any entry for the same panchayat")
    p.add_argument("--max-wards", type=int, default=15)
    p.add_argument("--max-tries", type=int, default=3)
    p.add_argument("--max-total-mb", type=float, default=25)
    p.add_argument("--interval", type=float, default=1.0)
    p.add_argument("--raw-dir", help="save each Search response here")
    p.add_argument("--log", help="append one JSON line per request here")
    args = p.parse_args(argv)
    args.repo = repo
    if args.interval < 1.0:
        p.error("--interval below 1.0 s is not allowed")
    picks = []
    for raw in args.pick:
        parts = raw.split(":")
        picks.append((parts[0], parts[1], parts[2].split(",") if len(parts) > 2 else []))
    manifest_path = args.manifest or os.path.join(args.out_dir, "manifest.json")
    entries = []
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as fh:
            entries = json.load(fh)["panchayats"]
    budget = {"bytes": sum(e["bytes"] for e in entries)}

    client = PoliteClient(interval=args.interval, log_path=args.log)
    form = RollForm(client)
    done = 0
    try:
        page0, _raw = form.start()
        for pick in picks:
            print(f"pick {':'.join(pick[:2])}", file=sys.stderr)
            entry = fetch_pick(client, form, page0, pick, args, budget)
            if entry:
                done += 1
                entries = [e for e in entries if e["panchayat"]["id"] != entry["panchayat"]["id"]]
                entries.append(entry)
                # Written after every panchayat so a later stop leaves no
                # downloaded file unrecorded.
                write_manifest(manifest_path, entries)
    except (Blocked, UnexpectedResponse) as exc:
        print(f"STOPPED: {exc}", file=sys.stderr)
        return 2
    finally:
        print(json.dumps({"requests": client.counts, "posts": form.posts,
                          "bytes": budget["bytes"]}), file=sys.stderr)
    return 0 if done == len(picks) else 3


if __name__ == "__main__":
    sys.exit(main())
