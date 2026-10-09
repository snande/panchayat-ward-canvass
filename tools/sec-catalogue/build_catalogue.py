#!/usr/bin/env python3
"""Build the ward catalogue of every gram panchayat the State Election
Commission of Rajasthan lists on its roll download page: data/sec/catalogue/
holds index.json (the districts) and one JSON file per district (its gram
panchayats and their wards' roll PDF URLs).

The run has two stages.

fetch walks the page (https://sec.rajasthan.gov.in/se_pdfdownload.aspx) and
saves every response body to a directory. The page is an ASP.NET WebForms
form with three cascading dropdowns. Each dropdown change is a POST that
carries the page's __VIEWSTATE and __EVENTVALIDATION back to the server, so
the walk replays those posts:

  1 GET of the page              -> page.html: the district list
  1 POST per district            -> district-<D>.html: its samitis and urban bodies
  1 POST per walked samiti       -> samiti-<D>-<S>.html: its gram panchayats
  1 Search POST per panchayat    -> search-<D>-<S>-<GP>.html: its ward grid

Only rural panchayat samitis are walked: an urban body's third dropdown lists
municipal wards, not gram panchayats. A ward's PDF URL is built from the
Final PDF template (samiti id, panchayat name, ward number); see
docs/research/sec-statewide-catalogue.md.

build reads such a directory, and nothing else, and writes the catalogue. It
makes no network request. It stops with a non-zero exit, naming the district
and panchayat, when a panchayat has no wards, a ward has no Final PDF link
(so no pdfUrl) or a ward number repeats within a panchayat. Urban bodies'
wards found in the input are skipped and counted in the summary printed to
stdout. Every file written carries schemaVersion; keys are sorted and the
indentation fixed, so two runs over the same input write identical bytes.

Standard library only. Live mode (no --input) fetches and then builds; it
must run from a networked machine, since the swarm's Engineer sandbox cannot
reach the commission's servers. It also writes the single-file
data/sec/catalogue.json that js/picker.js still reads.

    python3 tools/sec-catalogue/build_catalogue.py --input fixtures/sec/portal-responses --out data/sec/catalogue
    python3 tools/sec-catalogue/build_catalogue.py --raw-dir /tmp/sec-responses --max-posts 16000
    python3 tools/sec-catalogue/build_catalogue.py --districts 17 --raw-dir /tmp/jaipur --out /tmp/jaipur

Politeness: one request at a time, at least --interval seconds (default 1.0)
between the end of one request and the start of the next, a descriptive
User-Agent, exponential backoff on network errors and 5xx, and an immediate
stop on 403, 429, a redirect, or a response that is not the expected form
(anything that looks like blocking or a captcha). --max-posts caps the run;
a capped run builds nothing and resumes from its --raw-dir when run again,
skipping every response already saved.
"""

import argparse
import datetime as _dt
import http.cookiejar
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

SOURCE_PAGE = "https://sec.rajasthan.gov.in/se_pdfdownload.aspx"
WARD_PDF_URL_TEMPLATE = (
    "https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/"
    "{samiti_id}/{PANCHAYAT_NAME}-Ward%20No-{ward:03d}.pdf"
)
USER_AGENT = "takshavid-canvass-catalogue/1.0 (operator data staging)"

FIELD_PREFIX = "ctl00$ContentPlaceHolder1$"
DISTRICT_FIELD = FIELD_PREFIX + "DistrictDropDown"
PS_FIELD = FIELD_PREFIX + "PSDropDown"
GP_FIELD = FIELD_PREFIX + "GPDropDown"
SEARCH_FIELD = FIELD_PREFIX + "SearchButton"

_URBAN_RE = re.compile(
    r"\bNAGAR\s*(PALIKA|PARISHAD|NIGAM)\b|\bNAGARPALIKA\b|\bMUNICIPAL\b"
    r"|\bCORPORATION\b|\bMUNICIPALITY\b",
    re.I,
)
_RURAL_RE = re.compile(r"\bPANCHAYAT\s*SAMIT", re.I)
_ZILLA_RE = re.compile(r"\bZILLA\s*PARISHAD\b", re.I)
# Text that only a block page, challenge page or WAF rejection would carry.
_BLOCK_RE = re.compile(r"captcha|request rejected|access denied|too many requests", re.I)


class Blocked(RuntimeError):
    """The server answered in a way that looks like blocking; stop the run."""


class UnexpectedResponse(RuntimeError):
    """The response is not the form this script knows how to replay."""


def now_iso():
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PoliteClient:
    """Sequential HTTP client: a per-host gap between requests, a fixed
    User-Agent, backoff on transient errors, a stop on anything that looks
    like blocking, and a count of every request sent per host."""

    def __init__(self, interval=1.0, retries=4, backoff=2.0, timeout=60, log_path=None):
        self.interval = interval
        self.retries = retries
        self.backoff = backoff
        self.timeout = timeout
        self.log_path = log_path
        self.counts = {}
        self._last_end = {}
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies), _NoRedirect()
        )

    def _wait(self, host):
        last = self._last_end.get(host)
        if last is not None:
            gap = self.interval - (time.monotonic() - last)
            if gap > 0:
                time.sleep(gap)

    def _log(self, entry):
        if self.log_path:
            with open(self.log_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def request(self, url, data=None, accept_redirect=False):
        """Return (status, headers, body bytes). A 3xx is returned as-is when
        accept_redirect is true (the PDF host's missing-ward answer) and is a
        stop otherwise. 403 and 429 always stop the run."""
        host = urllib.parse.urlsplit(url).hostname
        body = urllib.parse.urlencode(data).encode("ascii") if data is not None else None
        headers = {"User-Agent": USER_AGENT, "Accept-Language": "en"}
        if body is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            headers["Referer"] = SOURCE_PAGE
        attempt = 0
        while True:
            self._wait(host)
            started = now_iso()
            self.counts[host] = self.counts.get(host, 0) + 1
            req = urllib.request.Request(url, data=body, headers=headers,
                                         method="POST" if body is not None else "GET")
            status, resp_headers, payload, error = None, {}, b"", None
            try:
                with self.opener.open(req, timeout=self.timeout) as resp:
                    status, resp_headers, payload = resp.status, dict(resp.headers), resp.read()
            except urllib.error.HTTPError as exc:
                status, resp_headers = exc.code, dict(exc.headers or {})
                try:
                    payload = exc.read()
                except Exception:  # noqa: BLE001 - the body is diagnostic only
                    payload = b""
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                error = f"{type(exc).__name__}: {exc}"
            finally:
                self._last_end[host] = time.monotonic()
            self._log({"at": started, "method": req.get_method(), "url": url,
                       "status": status, "bytes": len(payload), "error": error})

            if error is None and status is not None:
                if status in (403, 429):
                    raise Blocked(f"{req.get_method()} {url} answered {status}")
                if 300 <= status < 400:
                    if accept_redirect:
                        return status, resp_headers, payload
                    raise Blocked(f"{req.get_method()} {url} redirected ({status}) to "
                                  f"{resp_headers.get('Location')!r}")
                if status < 500:
                    return status, resp_headers, payload
                error = f"HTTP {status}"
            attempt += 1
            if attempt > self.retries:
                raise Blocked(f"{req.get_method()} {url} failed {attempt} times; last: {error}")
            delay = self.backoff * (2 ** (attempt - 1))
            print(f"  retry {attempt}/{self.retries} in {delay:.0f}s after {error}", file=sys.stderr)
            time.sleep(delay)


class FormPage(HTMLParser):
    """The parts of the roll page this script reads: hidden inputs, the
    dropdowns and their options, and the rows of every table (cell text plus
    any link targets) for the Search result."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = {}
        self.selects = {}
        self.rows = []
        self.anchors = []
        self._select = None
        self._option = None
        self._row = None
        self._cell = None
        self._anchor = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "input" and (a.get("type") or "").lower() == "hidden" and a.get("name"):
            self.hidden[a["name"]] = a.get("value") or ""
        elif tag == "select" and a.get("name"):
            self._select = a["name"]
            self.selects[self._select] = []
        elif tag == "option" and self._select is not None:
            self._option = {"value": a.get("value", ""), "text": "",
                            "selected": "selected" in a}
        elif tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"text": "", "links": []}
        elif tag == "a":
            self._anchor = {"href": a.get("href") or "", "onclick": a.get("onclick") or "",
                            "id": a.get("id") or "", "text": ""}
        elif tag == "input" and self._cell is not None:
            self._cell["links"].append({"input": a.get("name") or "", "value": a.get("value") or "",
                                        "onclick": a.get("onclick") or "", "type": a.get("type") or ""})

    def handle_endtag(self, tag):
        if tag == "option" and self._option is not None:
            self._option["text"] = " ".join(self._option["text"].split())
            self.selects[self._select].append(self._option)
            self._option = None
        elif tag == "select":
            self._select = None
        elif tag == "a" and self._anchor is not None:
            self._anchor["text"] = " ".join(self._anchor["text"].split())
            self.anchors.append(self._anchor)
            if self._cell is not None:
                self._cell["links"].append(self._anchor)
            self._anchor = None
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._cell["text"] = " ".join(self._cell["text"].split())
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._option is not None:
            self._option["text"] += data
        if self._cell is not None:
            self._cell["text"] += data
        if self._anchor is not None:
            self._anchor["text"] += data

    def options(self, field):
        """(value, text) of every real option of a dropdown, placeholder dropped."""
        return [(o["value"], o["text"]) for o in self.selects.get(field, [])
                if o["value"] not in ("", "0", "-1") and not o["text"].startswith("--")]

    def selected(self, field):
        for o in self.selects.get(field, []):
            if o["selected"]:
                return o["value"]
        return None


def parse_page(raw, what):
    text = raw.decode("utf-8", errors="replace")
    page = FormPage()
    page.feed(text)
    page.close()
    if "__VIEWSTATE" not in page.hidden or DISTRICT_FIELD not in page.selects:
        hint = " (looks like a block or challenge page)" if _BLOCK_RE.search(text) else ""
        raise UnexpectedResponse(f"{what}: response is not the roll form{hint}")
    return page


def kind_of(name):
    if _URBAN_RE.search(name):
        return "urban"
    if _RURAL_RE.search(name):
        return "rural"
    return "unknown"


def should_walk(name):
    """Walk an entry for its gram panchayats only when it is a rural samiti.
    Urban bodies list municipal wards and a zilla parishad entry is not a
    samiti; both keep an empty panchayat list."""
    return kind_of(name) == "rural"


class RollForm:
    """Replays the page's dropdown postbacks."""

    def __init__(self, client):
        self.client = client
        self.posts = 0

    def _post_fields(self, page, overrides, target):
        fields = dict(page.hidden)
        fields["__EVENTTARGET"] = target
        fields["__EVENTARGUMENT"] = ""
        fields["__LASTFOCUS"] = ""
        for field in (DISTRICT_FIELD, PS_FIELD, GP_FIELD):
            value = page.selected(field)
            if value:
                fields[field] = value
        fields.update(overrides)
        return fields

    def _post(self, page, overrides, target, what):
        status, _headers, raw = self.client.request(
            SOURCE_PAGE, data=self._post_fields(page, overrides, target))
        self.posts += 1
        if status != 200:
            raise UnexpectedResponse(f"{what}: HTTP {status}")
        return parse_page(raw, what), raw

    def start(self):
        status, _headers, raw = self.client.request(SOURCE_PAGE)
        if status != 200:
            raise UnexpectedResponse(f"page: HTTP {status}")
        return parse_page(raw, "page"), raw

    def select_district(self, page, district_id):
        new, raw = self._post(page, {DISTRICT_FIELD: district_id}, DISTRICT_FIELD,
                              f"district {district_id}")
        if new.selected(DISTRICT_FIELD) != district_id:
            raise UnexpectedResponse(f"district {district_id}: the postback did not select it")
        return new, raw

    def select_samiti(self, district_page, district_id, samiti_id):
        new, raw = self._post(district_page, {DISTRICT_FIELD: district_id, PS_FIELD: samiti_id},
                              PS_FIELD, f"samiti {samiti_id}")
        if new.selected(PS_FIELD) != samiti_id:
            raise UnexpectedResponse(f"samiti {samiti_id}: the postback did not select it")
        return new, raw

    def search(self, samiti_page, district_id, samiti_id, gp_id):
        fields = {DISTRICT_FIELD: district_id, PS_FIELD: samiti_id, GP_FIELD: gp_id,
                  SEARCH_FIELD: "Search"}
        return self._post(samiti_page, fields, "", f"search {gp_id}")

    def click(self, result_page, district_id, samiti_id, gp_id, target):
        """Post a link postback from a Search result (a ward's PDF link).
        Returns (status, headers, body); the PDF location arrives either as a
        redirect or inside the returned page."""
        fields = self._post_fields(result_page, {DISTRICT_FIELD: district_id,
                                                 PS_FIELD: samiti_id, GP_FIELD: gp_id}, target)
        self.posts += 1
        return self.client.request(SOURCE_PAGE, data=fields, accept_redirect=True)


# --- saved responses ---------------------------------------------------------

SCHEMA_VERSION = 1
NAME_COLUMN = "Grampanchayat"
WARD_COLUMN = "Ward No."
FINAL_COLUMN = "Final PDF"
_TARGET_RE = re.compile(r'WebForm_PostBackOptions\("([^"]+)"|__doPostBack\(\'([^\']+)\'')
_SAVED_RE = re.compile(r"^(?:page|district-(\w+)|samiti-(\w+)-(\w+)|search-(\w+)-(\w+)-(\w+))\.html$")
_WARD_NUMBER_RE = re.compile(r"[0-9]+")


class CatalogueError(RuntimeError):
    """The saved responses describe a panchayat the catalogue cannot list."""

    def __init__(self, district, panchayat, reason):
        super().__init__(f"district {district[1]} ({district[0]}), "
                         f"panchayat {panchayat[1]} ({panchayat[0]}): {reason}")


class _OverCap(Exception):
    """The next post would go over --max-posts."""


def grid_rows(page):
    """The Search result grid: (column headers, data rows). A row is
    {"cells": [text], "links": {column header: postback target}}; rows whose
    cell count differs from the header row (a pager, say) are skipped."""
    headers = None
    rows = []
    for row in page.rows:
        texts = [c["text"] for c in row]
        if headers is None:
            if WARD_COLUMN in texts:
                headers = texts
            continue
        if len(row) != len(headers):
            continue
        links = {}
        for header, cell in zip(headers, row):
            for link in cell["links"]:
                m = _TARGET_RE.search(link.get("href") or "")
                if m:
                    links[header] = m.group(1) or m.group(2)
        rows.append({"cells": texts, "links": links})
    return headers or [], rows


def result_grid(page):
    """The ward rows of a Search result that carry a link and a ward number:
    (column headers, rows), each row {"cells", "ward": int, "links"}."""
    headers, rows = grid_rows(page)
    out = []
    for row in rows:
        ward = row["cells"][headers.index(WARD_COLUMN)]
        if row["links"] and _WARD_NUMBER_RE.fullmatch(ward):
            out.append({"cells": row["cells"], "ward": int(ward), "links": row["links"]})
    return headers, out


def district_slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def ward_pdf_url(samiti_id, panchayat_name, ward):
    """The Final PDF of a ward: the dropdown name upper-cased, spaces as %20."""
    return WARD_PDF_URL_TEMPLATE.format(
        samiti_id=samiti_id, PANCHAYAT_NAME=urllib.parse.quote(panchayat_name.upper(), safe=""),
        ward=ward)


class SavedResponses:
    """A directory of response bodies saved by the fetch stage, by name."""

    def __init__(self, path):
        if not os.path.isdir(path):
            raise UnexpectedResponse(f"{path}: not a directory")
        self.path = path
        self.files = 0
        self.districts = {}
        self.samitis = {}
        self.searches = {}
        for name in sorted(os.listdir(path)):
            m = _SAVED_RE.match(name)
            if not m:
                continue
            self.files += 1
            if m.group(1):
                self.districts[m.group(1)] = name
            elif m.group(2):
                self.samitis[(m.group(2), m.group(3))] = name
            elif m.group(4):
                self.searches[(m.group(4), m.group(5), m.group(6))] = name
        if not os.path.exists(os.path.join(path, "page.html")):
            raise UnexpectedResponse(f"{path}: no page.html (the district list)")

    def page(self, name):
        with open(os.path.join(self.path, name), "rb") as fh:
            return parse_page(fh.read(), name)

    def district(self, did):
        name = self.districts.get(did)
        if name is None:
            return None
        page = self.page(name)
        if page.selected(DISTRICT_FIELD) != did:
            raise UnexpectedResponse(f"{name}: the response does not select district {did}")
        return page

    def samiti(self, did, sid):
        name = self.samitis.get((did, sid))
        if name is None:
            return None
        page = self.page(name)
        if page.selected(PS_FIELD) != sid:
            raise UnexpectedResponse(f"{name}: the response does not select samiti {sid}")
        return page


# --- build -------------------------------------------------------------------

def read_panchayat(saved, district, samiti, panchayat):
    """One gram panchayat from its saved Search response, validated."""
    did, sid, gp = district[0], samiti[0], panchayat[0]
    name = saved.searches[(did, sid, gp)]
    page = saved.page(name)
    selected = page.selected(GP_FIELD)
    if selected and selected != gp:
        raise UnexpectedResponse(f"{name}: the response selects panchayat {selected}, not {gp}")
    headers, rows = grid_rows(page)
    if not rows:
        raise CatalogueError(district, panchayat, "the Search result lists zero wards")
    if not panchayat[1]:
        raise CatalogueError(district, panchayat, "no name in the samiti's dropdown, so no pdfUrl")
    ward_at = headers.index(WARD_COLUMN)
    name_at = headers.index(NAME_COLUMN) if NAME_COLUMN in headers else None
    hindi = ""
    wards = {}
    for row in rows:
        text = row["cells"][ward_at]
        if not _WARD_NUMBER_RE.fullmatch(text) or int(text) < 1:
            raise CatalogueError(district, panchayat, f"ward number {text!r} is not a number")
        ward = int(text)
        if ward in wards:
            raise CatalogueError(district, panchayat, f"ward {ward} repeats")
        if not row["links"].get(FINAL_COLUMN):
            raise CatalogueError(district, panchayat,
                                 f"ward {ward} has no pdfUrl (no {FINAL_COLUMN!r} link)")
        if name_at is not None and not hindi:
            hindi = row["cells"][name_at]
        wards[ward] = {"ward": ward, "pdfUrl": ward_pdf_url(sid, panchayat[1], ward)}
    return {
        "id": gp,
        "name": hindi or panchayat[1],
        "nameLatin": panchayat[1],
        "block": samiti[1],
        "blockId": sid,
        "wards": [wards[w] for w in sorted(wards)],
    }


def collect(saved):
    """Every gram panchayat in the saved responses, by district:
    (districts, summary). Raises CatalogueError on the first invalid one."""
    summary = {"districts": 0, "panchayats": 0, "wards": 0,
               "districtsNotFetched": 0, "districtsWithoutPanchayats": 0,
               "samitisNotFetched": 0, "panchayatsNotSearched": 0,
               "urbanBodiesSkipped": 0, "urbanWardsSkipped": 0, "otherEntriesSkipped": 0}
    used = set()
    districts = []
    for did, dname in saved.page("page.html").options(DISTRICT_FIELD):
        district_page = saved.district(did)
        if district_page is None:
            summary["districtsNotFetched"] += 1
            continue
        panchayats = []
        for sid, sname in district_page.options(PS_FIELD):
            samiti_page = saved.samiti(did, sid)
            kind = kind_of(sname)
            if kind != "rural":
                # An urban body's third dropdown lists municipal wards; a
                # zilla parishad or blank entry lists nothing to canvass.
                used.update(k for k in saved.searches if k[:2] == (did, sid))
                if samiti_page is not None:
                    if kind == "urban":
                        summary["urbanBodiesSkipped"] += 1
                        summary["urbanWardsSkipped"] += len(samiti_page.options(GP_FIELD))
                    else:
                        summary["otherEntriesSkipped"] += 1
                continue
            if samiti_page is None:
                summary["samitisNotFetched"] += 1
                continue
            for gp, gname in samiti_page.options(GP_FIELD):
                if (did, sid, gp) not in saved.searches:
                    summary["panchayatsNotSearched"] += 1
                    continue
                used.add((did, sid, gp))
                panchayats.append(read_panchayat(saved, (did, dname), (sid, sname), (gp, gname)))
        if not panchayats:
            summary["districtsWithoutPanchayats"] += 1
            continue
        panchayats.sort(key=lambda p: (p["name"], p["id"]))
        districts.append({"id": did, "name": dname, "panchayats": panchayats})
        summary["districts"] += 1
        summary["panchayats"] += len(panchayats)
        summary["wards"] += sum(len(p["wards"]) for p in panchayats)
    stray = sorted(saved.searches[k] for k in set(saved.searches) - used)
    if stray:
        raise UnexpectedResponse(f"{stray[0]}: a Search response for a panchayat that is not in "
                                 f"its saved district and samiti dropdowns")
    return districts, summary


def write_json(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=1) + "\n")


def write_shards(out_dir, districts):
    """index.json plus one file per district. Files a previous index listed
    that this run does not write are removed."""
    os.makedirs(out_dir, exist_ok=True)
    index_path = os.path.join(out_dir, "index.json")
    previous = set()
    if os.path.exists(index_path):
        try:
            with open(index_path, encoding="utf-8") as fh:
                previous = {d["file"] for d in json.load(fh)["districts"]}
        except (ValueError, KeyError, TypeError):
            previous = set()
    entries = []
    taken = {"index.json"}
    for d in sorted(districts, key=lambda d: (d["name"], d["id"])):
        file = (district_slug(d["name"]) or f"district-{d['id']}") + ".json"
        if file in taken:
            file = f"{file[:-5]}-{d['id']}.json"
        taken.add(file)
        write_json(os.path.join(out_dir, file), {
            "schemaVersion": SCHEMA_VERSION,
            "districtId": d["id"],
            "districtName": d["name"],
            "panchayats": d["panchayats"],
        })
        entries.append({"id": d["id"], "name": d["name"], "file": file,
                        "panchayatCount": len(d["panchayats"])})
    write_json(index_path, {
        "schemaVersion": SCHEMA_VERSION,
        "sourcePage": SOURCE_PAGE,
        "districts": entries,
    })
    for file in sorted(previous - taken):
        path = os.path.join(out_dir, file)
        if os.path.basename(file) == file and file.endswith(".json") and os.path.exists(path):
            os.remove(path)


def legacy_catalogue(saved, request_note):
    """The single-file catalogue (districts, samitis, panchayat ids and Latin
    names, no wards) that js/picker.js reads until it moves to the shards."""
    out_districts = []
    counts = {"districts": 0, "samitis": 0, "rural": 0, "urban": 0, "unknown": 0,
              "walked": 0, "panchayats": 0}
    for did, dname in saved.page("page.html").options(DISTRICT_FIELD):
        district_page = saved.district(did)
        if district_page is None:
            continue
        samitis = []
        for sid, sname in district_page.options(PS_FIELD):
            kind = kind_of(sname)
            counts["samitis"] += 1
            counts[kind] += 1
            samiti_page = saved.samiti(did, sid) if kind == "rural" else None
            panchayats = samiti_page.options(GP_FIELD) if samiti_page is not None else []
            if samiti_page is not None:
                counts["walked"] += 1
                counts["panchayats"] += len(panchayats)
            samitis.append({"id": sid, "name": sname, "kind": kind,
                            "panchayats": [{"id": p, "name": n} for p, n in panchayats]})
        counts["districts"] += 1
        out_districts.append({"id": did, "name": dname, "samitis": samitis})
    notes = [
        f"Counts: {counts['districts']} districts; {counts['samitis']} entries in the second "
        f"dropdown ({counts['rural']} rural panchayat samitis, {counts['urban']} urban bodies, "
        f"{counts['unknown']} other, e.g. zilla parishads); {counts['panchayats']} gram "
        f"panchayats across {counts['walked']} walked samitis.",
        "Only rural panchayat samitis are walked for gram panchayats. Urban bodies (nagar "
        "palika, nagar parishad, nagar nigam) list municipal wards in the third dropdown and "
        "zilla parishad entries are not samitis; both keep an empty panchayats list.",
        "kind is read from the portal's Latin name: 'urban' for nagar palika / parishad / "
        "nigam, 'rural' for panchayat samiti, 'unknown' otherwise.",
        "Ward lists are not stored here; they are in the per-district files under "
        "data/sec/catalogue/. PANCHAYAT_NAME is the panchayat's name exactly as listed here, "
        "upper-cased, with spaces percent-encoded.",
        request_note,
    ]
    return {
        "generated_at": now_iso(),
        "source_page": SOURCE_PAGE,
        "ward_pdf_url_template": WARD_PDF_URL_TEMPLATE.replace("{ward:03d}", "{NNN}"),
        "notes": notes,
        "districts": out_districts,
    }


# --- fetch -------------------------------------------------------------------

def _saved_path(raw_dir, name):
    return os.path.join(raw_dir, name)


def _save_raw(raw_dir, name, raw):
    os.makedirs(raw_dir, exist_ok=True)
    tmp = _saved_path(raw_dir, name + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(raw)
    os.replace(tmp, _saved_path(raw_dir, name))


def _read_saved(raw_dir, name):
    path = _saved_path(raw_dir, name)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return parse_page(fh.read(), name)


def fetch(args, client, form, raw_dir):
    """Save the responses the build stage reads into raw_dir. A response
    already saved there is not fetched again (a district or samiti page is
    re-posted only when Search still needs its form state). Returns False
    when --max-posts stopped the walk."""
    only_districts = set(filter(None, (args.districts or "").split(",")))
    only_samitis = set(filter(None, (args.samitis or "").split(",")))

    def spend():
        if form.posts >= args.max_posts:
            raise _OverCap()

    page0, raw = form.start()
    _save_raw(raw_dir, "page.html", raw)
    districts = [(v, t) for v, t in page0.options(DISTRICT_FIELD)
                 if not only_districts or v in only_districts]
    print(f"{len(districts)} districts", file=sys.stderr)
    try:
        for did, dname in districts:
            live = {}

            def district_page():
                if "page" not in live:
                    spend()
                    live["page"], raw = form.select_district(page0, did)
                    _save_raw(raw_dir, f"district-{did}.html", raw)
                return live["page"]

            dpage = _read_saved(raw_dir, f"district-{did}.html") or district_page()
            samitis = [(s, n) for s, n in dpage.options(PS_FIELD)
                       if (s in only_samitis if only_samitis else should_walk(n))]
            print(f"  {dname}: walking {len(samitis)} samitis", file=sys.stderr)
            for sid, sname in samitis:
                name = f"samiti-{did}-{sid}.html"
                spage_live = None
                spage = _read_saved(raw_dir, name)
                if spage is None:
                    spend()
                    spage_live, raw = form.select_samiti(district_page(), did, sid)
                    _save_raw(raw_dir, name, raw)
                    spage = spage_live
                if args.skip_search or not should_walk(sname):
                    continue
                todo = [gp for gp, _n in spage.options(GP_FIELD)
                        if not os.path.exists(_saved_path(raw_dir, f"search-{did}-{sid}-{gp}.html"))]
                if todo and spage_live is None:
                    spend()
                    spage_live, _raw = form.select_samiti(district_page(), did, sid)
                for gp in todo:
                    spend()
                    _result, raw = form.search(spage_live, did, sid, gp)
                    _save_raw(raw_dir, f"search-{did}-{sid}-{gp}.html", raw)
                print(f"    {sname}: {len(spage.options(GP_FIELD))} panchayats, "
                      f"{len(todo)} searched now", file=sys.stderr)
    except _OverCap:
        return False
    return True


# --- main --------------------------------------------------------------------

def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--input", help="build from the saved portal responses in this directory, "
                                   "with no network access (default: fetch them first)")
    p.add_argument("--out", default=os.path.join(repo, "data", "sec", "catalogue"),
                   help="directory for index.json and the per-district files")
    p.add_argument("--legacy-out", help="also write the single-file catalogue here (live mode "
                                        "default: data/sec/catalogue.json)")
    p.add_argument("--raw-dir", help="live mode: save every response here and resume from it "
                                     "(default: a new temporary directory)")
    p.add_argument("--interval", type=float, default=1.0,
                   help="minimum seconds between one request ending and the next starting")
    p.add_argument("--max-posts", type=int, default=450,
                   help="stop the walk before this many form posts; rerun with the same "
                        "--raw-dir to continue")
    p.add_argument("--districts", help="comma-separated district ids to fetch (default: all)")
    p.add_argument("--samitis", help="comma-separated samiti ids to walk, whatever their kind")
    p.add_argument("--skip-search", action="store_true",
                   help="fetch the dropdowns only: writes the single-file catalogue, no shards")
    p.add_argument("--log", help="append one JSON line per request here")
    args = p.parse_args(argv)
    if args.interval < 1.0:
        p.error("--interval below 1.0 s is not allowed")
    if args.input and (args.raw_dir or args.districts or args.samitis or args.skip_search):
        p.error("--raw-dir, --districts, --samitis and --skip-search fetch; --input does not")

    try:
        if args.input:
            input_dir, legacy_out = args.input, args.legacy_out
            request_note = "Built from saved portal responses; no requests made."
        else:
            input_dir = args.raw_dir or tempfile.mkdtemp(prefix="sec-responses-")
            legacy_out = args.legacy_out or os.path.join(repo, "data", "sec", "catalogue.json")
            print(f"saving responses in {input_dir}", file=sys.stderr)
            client = PoliteClient(interval=args.interval, log_path=args.log)
            form = RollForm(client)
            complete = fetch(args, client, form, input_dir)
            print(json.dumps({"requests": client.counts, "posts": form.posts}), file=sys.stderr)
            if not complete:
                print(f"INCOMPLETE: stopped at the cap of {args.max_posts} posts; nothing built. "
                      f"Run again with --raw-dir {input_dir} to continue.", file=sys.stderr)
                return 3
            request_note = (f"Requests: {sum(client.counts.values())} to sec.rajasthan.gov.in "
                            f"({form.posts} form posts), at most one per {args.interval:g} s.")
        saved = SavedResponses(input_dir)
        if not args.skip_search:
            districts, summary = collect(saved)
            write_shards(args.out, districts)
        if legacy_out:
            catalogue = legacy_catalogue(saved, request_note)
            os.makedirs(os.path.dirname(os.path.abspath(legacy_out)), exist_ok=True)
            with open(legacy_out, "w", encoding="utf-8") as fh:
                json.dump(catalogue, fh, ensure_ascii=False, indent=1)
                fh.write("\n")
    except CatalogueError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    except (Blocked, UnexpectedResponse) as exc:
        print(f"STOPPED: {exc}", file=sys.stderr)
        return 2
    if not args.skip_search:
        print(json.dumps({"summary": summary}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
