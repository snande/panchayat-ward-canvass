#!/usr/bin/env python3
"""Build the statewide ward catalogue from the State Election Commission of
Rajasthan's roll download page, as saved responses, into a versioned,
per-district sharded catalogue.

    python3 tools/sec-catalogue/build_catalogue.py --input DIR --out data/sec/catalogue
    python3 tools/sec-catalogue/build_catalogue.py --fetch DIR --out data/sec/catalogue

The page (https://sec.rajasthan.gov.in/se_pdfdownload.aspx) is an ASP.NET
WebForms form with three cascading dropdowns and a Search button. Each
dropdown change is a POST that carries the page's __VIEWSTATE and
__EVENTVALIDATION back to the server, so a walk replays those posts:

  1 GET of the page              -> page.html: the district list
  1 POST per district            -> district-<D>.html: its samitis and urban bodies
  1 POST per rural samiti        -> samiti-<D>-<S>.html: its gram panchayats (Latin)
  1 Search POST per panchayat    -> search-<D>-<S>-<G>.html: the ward grid
  1 GET per rural samiti         -> cover-<S>.pdf: ward 1's Final roll PDF of the
                                    samiti's first panchayat that lists one, for
                                    its cover page (cover-<S>.missing.json when
                                    no panchayat's ward 1 PDF could be had)

--input builds from such a directory with no network access. --fetch walks
the portal into the directory first (see below) and then builds from it.

Where each field comes from (decision on #121: Hindi names only from SEC
publications, nothing hand-made):

- gram panchayat Hindi name: the Search grid's `Grampanchayat` column;
- district and panchayat samiti Hindi names: the cover page of the samiti's
  cover-<S>.pdf, read by the repo's glyph-matching decoder
  (src/decoder/rollCover.js through read_covers.mjs; no OCR);
- Latin names: the dropdown text;
- wards: the grid's `Ward No.` rows. `pdfUrl` is the Final template for a row
  whose `Final PDF` cell links a PDF; `supplementUrl` is the Supplement
  template for a row whose `Final With Supp-<n> PDF` cell links one, else
  null (docs/research/sec-statewide-catalogue.md, section 3). No ward number
  is probed.

A Hindi name that cannot be read falls back to the Latin name and is listed
in the run summary; that never fails the run. The build fails (exit 1, naming
the district and panchayat) when a panchayat has no wards, a Search response
holds no ward grid, a ward has no Final PDF link, a ward number repeats or is
not a number, the grid's Grampanchayat cells disagree, or a saved response is
missing. Only rural panchayat samitis are walked; urban bodies, zilla
parishads and blank-named entries are counted and skipped.

Output, every file carrying schemaVersion and written byte-identically for
the same input:

  <out>/index.json         districts with id, name, nameLatin, file, panchayatCount
  <out>/<district>.json    the district's panchayats, sorted by Hindi name, each
                           with block (its samiti) and wards sorted by number
  --legacy-out FILE        the older single-file catalogue.json shape, written
                           only when asked for: the picker reads the sharded
                           catalogue (#122) and data/sec/catalogue.json is gone

A full build replaces the catalogue and removes shards the earlier index
listed that it no longer writes. A --districts build only replaces the named
districts: it merges them into the existing index and older catalogue and
removes nothing else.

Live mode (--fetch DIR) needs a networked machine: the swarm's Engineer
sandbox cannot reach the commission's servers. It saves every response into
DIR under the names above, skips any response already saved (an interrupted
run resumes where it stopped; files are written whole or not at all) and
prints progress with an estimated finish time. Politeness: one request at a
time, at least --interval seconds (default 1.0, never less) between the end of
one request to a host and the start of the next, a descriptive User-Agent,
exponential backoff on network errors and 5xx, and an immediate stop on 403,
429, an unexpected redirect, or a response that is not the expected form
(anything that looks like blocking or a captcha). The whole state is about
15,400 requests: 41 district posts, 457 samiti posts, one Search post per
gram panchayat (14,403; the Search post carries the panchayat selection) and
457 cover PDFs. That is about 4.5 hours at the floor rate, and longer with
the portal's response times.

Standard library only, plus `node` for reading covers.
"""

import argparse
import datetime as _dt
import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
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


SCHEMA_VERSION = 1
SUPPLEMENT_PDF_URL_TEMPLATE = (
    "https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Supplement/"
    "{samiti_id}/{PANCHAYAT_NAME}-Ward%20No-{ward:03d}.pdf"
)
GP_COLUMN = "Grampanchayat"
WARD_COLUMN = "Ward No."
FINAL_COLUMN = "Final PDF"
_SUPP_COLUMN_RE = re.compile(r"^Final\s+With\s+Supp", re.I)
_TARGET_RE = re.compile(r'WebForm_PostBackOptions\("([^"]+)"|__doPostBack\(\'([^\']+)\'')
_DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")
_SAMITI_SUFFIX_RE = re.compile(r"\s*PANCHAYAT\s*SAMITI\s*$", re.I)
_SAFE_ID_RE = re.compile(r"[^0-9A-Za-z_-]")

READ_COVERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "read_covers.mjs")
PAGE_FILE = "page.html"
META_FILE = "meta.json"
INDEX_FILE = "index.json"

# For the live-mode estimate only, until a dropdown has been seen: the
# 2026-10-09 walk found 457 rural samitis in 41 districts and 14,403 gram
# panchayats (docs/research/sec-statewide-catalogue.md, section 2).
AVG_RURAL_SAMITIS = 457 / 41
AVG_PANCHAYATS = 14403 / 457


class InputError(RuntimeError):
    """A saved input file is unusable as a whole (not a per-panchayat failure)."""


def _safe(i):
    return _SAFE_ID_RE.sub("_", i)


def district_file(did):
    return f"district-{_safe(did)}.html"


def samiti_file(did, sid):
    return f"samiti-{_safe(did)}-{_safe(sid)}.html"


def search_file(did, sid, gp):
    return f"search-{_safe(did)}-{_safe(sid)}-{_safe(gp)}.html"


def cover_file(sid):
    return f"cover-{_safe(sid)}.pdf"


def cover_missing_file(sid):
    """Written by --fetch when no panchayat of the samiti yielded a ward 1
    Final PDF, so a resumed run does not ask again (delete it to retry)."""
    return f"cover-{_safe(sid)}.missing.json"


def entry_kind(name):
    """'rural', 'urban', 'zillaParishad' or 'other' (blank or unrecognised)."""
    if _ZILLA_RE.search(name):
        return "zillaParishad"
    kind = kind_of(name)
    return kind if kind != "unknown" else "other"


def pdf_url(template, samiti_id, panchayat_latin, ward):
    """A ward's PDF URL: the panchayat's dropdown text upper-cased, with
    spaces and anything else outside A-Z, 0-9, '-', '.', '_', '~'
    percent-encoded (a space becomes %20)."""
    name = urllib.parse.quote(panchayat_latin.upper(), safe="")
    return template.format(samiti_id=samiti_id, PANCHAYAT_NAME=name, ward=ward)


def _is_link(link):
    if "href" in link:
        return bool(_TARGET_RE.search(link["href"]) or link["href"].lower().endswith(".pdf")
                    or link.get("onclick"))
    return (link.get("type") or "").lower() in ("image", "submit")


def search_grid(page):
    """The Search result grid: (column headers, rows), or ([], []) when the
    page holds no grid. A row is {"cells": [text], "links": set of headers
    whose cell holds a link}."""
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
        links = {h for h, cell in zip(headers, row) if any(_is_link(ln) for ln in cell["links"])}
        rows.append({"cells": texts, "links": links})
    return headers or [], rows


def grid_wards(page):
    """From a saved Search response: (has a ward grid, the distinct Hindi
    Grampanchayat cell texts in row order, [{"ward": text, "final": bool,
    "supplement": bool}])."""
    headers, rows = search_grid(page)
    if not headers:
        return False, [], []
    wi = headers.index(WARD_COLUMN)
    gi = headers.index(GP_COLUMN) if GP_COLUMN in headers else None
    supp = [h for h in headers if _SUPP_COLUMN_RE.match(h)]
    names = []
    wards = []
    for r in rows:
        if gi is not None and _DEVANAGARI_RE.search(r["cells"][gi]):
            name = unicodedata.normalize("NFC", r["cells"][gi])
            if name not in names:
                names.append(name)
        wards.append({"ward": r["cells"][wi], "final": FINAL_COLUMN in r["links"],
                      "supplement": any(h in r["links"] for h in supp)})
    return True, names, wards


class SavedResponses:
    """Read access to a directory of saved responses."""

    def __init__(self, root):
        self.root = root

    def path(self, name):
        return os.path.join(self.root, name)

    def has(self, name):
        return os.path.isfile(self.path(name))

    def read(self, name):
        with open(self.path(name), "rb") as fh:
            return fh.read()

    def page(self, name):
        return parse_page(self.read(name), name)

    def meta(self):
        if not self.has(META_FILE):
            return {}
        try:
            meta = json.loads(self.read(META_FILE).decode("utf-8"))
        except ValueError:
            meta = None
        if not isinstance(meta, dict):
            raise InputError(f"{META_FILE} in {self.root} is not valid JSON; "
                             "delete or regenerate it")
        return meta


def node_available():
    return shutil.which("node") is not None


def read_covers(paths):
    """{path: {"district": str|None, "samiti": str|None[, "error": str]}} for
    each cover PDF, read by tools/sec-catalogue/read_covers.mjs. A failure to
    run node reads as no names, never as an error."""
    out = {}
    node = shutil.which("node")
    for i in range(0, len(paths), 100):
        chunk = paths[i:i + 100]
        if node is None:
            out.update({p: {"district": None, "samiti": None, "error": "node not found"}
                        for p in chunk})
            continue
        try:
            done = subprocess.run([node, READ_COVERS, *chunk], capture_output=True, check=True,
                                  timeout=1800)
            out.update(json.loads(done.stdout.decode("utf-8")))
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            out.update({p: {"district": None, "samiti": None, "error": f"read_covers: {exc}"}
                        for p in chunk})
    return out


def _hindi(value):
    if isinstance(value, str) and _DEVANAGARI_RE.search(value):
        return unicodedata.normalize("NFC", value)
    return None


def _slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def shard_names(districts):
    """District id -> shard file name, decided over the portal's whole
    district list so a --districts build names a district's shard exactly as
    a full build does: '<latin-slug>.json', with '-<id>' added when two
    districts share a slug."""
    slugs = {did: _slug(name) or f"district-{_safe(did)}" for did, name in districts}
    taken = {}
    for s in slugs.values():
        taken[s] = taken.get(s, 0) + 1
    return {did: (f"{s}-{_safe(did)}.json" if taken[s] > 1 or s == "index" else f"{s}.json")
            for did, s in slugs.items()}


def build_catalogue(input_dir, only_districts=None, cover_reader=None):
    """Build the catalogue from saved responses. Returns (files, summary,
    errors, legacy): files maps a name relative to --out ("index.json",
    "<district>.json") to its document; errors lists every failure, each
    naming its district and panchayat; legacy is the older catalogue.json
    document. Nothing here touches the network."""
    saved = SavedResponses(input_dir)
    cover_reader = cover_reader or read_covers
    errors = []
    if not saved.has(PAGE_FILE):
        return {}, {}, [f"no saved response {PAGE_FILE} in {input_dir}"], None
    portal = saved.page(PAGE_FILE).options(DISTRICT_FIELD)
    files_for = shard_names(portal)
    districts = [(v, t) for v, t in portal if not only_districts or v in only_districts]
    if only_districts:
        unknown = sorted(set(only_districts) - {v for v, _t in portal})
        if unknown:
            errors.append(f"--districts {','.join(unknown)}: no such district in {PAGE_FILE}")
        if not districts:
            return {}, {}, errors, None
    skipped = {"urban": 0, "zillaParishad": 0, "other": 0}
    walked = []  # (did, dname, [(sid, sname, [(gp, gname, hindi, wards)])])
    legacy = []
    for did, dname in districts:
        where = f"district {dname} ({did})"
        if not saved.has(district_file(did)):
            errors.append(f"{where}: no saved response {district_file(did)}")
            continue
        samitis = []
        legacy_samitis = []
        for sid, sname in saved.page(district_file(did)).options(PS_FIELD):
            kind = entry_kind(sname)
            legacy_samitis.append({"id": sid, "name": sname, "kind": kind_of(sname),
                                   "panchayats": []})
            if kind != "rural":
                skipped[kind] += 1
                continue
            swhere = f"{where} / samiti {sname} ({sid})"
            if not saved.has(samiti_file(did, sid)):
                errors.append(f"{swhere}: no saved response {samiti_file(did, sid)}")
                continue
            panchayats = []
            for gp, gname in saved.page(samiti_file(did, sid)).options(GP_FIELD):
                legacy_samitis[-1]["panchayats"].append({"id": gp, "name": gname})
                pwhere = f"{where} / panchayat {gname} ({gp})"
                sfile = search_file(did, sid, gp)
                if not saved.has(sfile):
                    errors.append(f"{pwhere}: no saved Search response {sfile}, so no wards")
                    continue
                has_grid, names, rows = grid_wards(saved.page(sfile))
                if not has_grid:
                    errors.append(f"{pwhere}: no ward grid in {sfile} (no '{WARD_COLUMN}' "
                                  "column; an error page or an empty result?)")
                    continue
                if len(names) > 1:
                    errors.append(f"{pwhere}: the {GP_COLUMN} cells of {sfile} disagree "
                                  f"({', '.join(names)}); the grid is not one panchayat's")
                    continue
                if not rows:
                    errors.append(f"{pwhere}: zero wards in the Search grid of {sfile}")
                    continue
                wards = []
                seen = set()
                for row in rows:
                    if not row["ward"].isdigit():
                        errors.append(f"{pwhere}: ward number {row['ward']!r} is not a number")
                        continue
                    n = int(row["ward"])
                    if n in seen:
                        errors.append(f"{pwhere}: ward {n} repeats")
                        continue
                    seen.add(n)
                    if not row["final"]:
                        errors.append(f"{pwhere}: ward {n} has no {FINAL_COLUMN} link, so no pdfUrl")
                        continue
                    wards.append({
                        "ward": n,
                        "pdfUrl": pdf_url(WARD_PDF_URL_TEMPLATE, sid, gname, n),
                        "supplementUrl": (pdf_url(SUPPLEMENT_PDF_URL_TEMPLATE, sid, gname, n)
                                          if row["supplement"] else None),
                    })
                hindi = names[0] if names else None
                panchayats.append((gp, gname, hindi, sorted(wards, key=lambda w: w["ward"])))
            samitis.append((sid, sname, panchayats))
        walked.append((did, dname, samitis))
        legacy.append({"id": did, "name": dname, "samitis": legacy_samitis})

    cover_paths = sorted({saved.path(cover_file(sid)) for _d, _n, ss in walked
                          for sid, _s, _p in ss if saved.has(cover_file(sid))})
    covers = cover_reader(cover_paths) if cover_paths else {}

    def cover(sid):
        return covers.get(saved.path(cover_file(sid))) or {"district": None, "samiti": None}

    def no_cover_reason(sid, what):
        if saved.has(cover_file(sid)):
            return f"no Hindi {what} name read from {cover_file(sid)}"
        if saved.has(cover_missing_file(sid)):
            return f"the portal gave no cover PDF ({cover_missing_file(sid)})"
        return f"{cover_file(sid)} not saved"

    fallbacks = []
    notes = []
    files = {}
    index_districts = []
    counts = {"districts": 0, "samitis": 0, "panchayats": 0, "wards": 0, "wardsWithSupplement": 0}
    for did, dname, samitis in walked:
        readings = {}
        for sid, _sname, _p in samitis:
            name = _hindi(cover(sid).get("district"))
            if name:
                readings[name] = readings.get(name, 0) + 1
        if readings:
            dhindi = sorted(readings.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
            if len(readings) > 1:
                notes.append(f"district {dname} ({did}): covers disagree on the Hindi name "
                             f"({', '.join(f'{k} x{v}' for k, v in sorted(readings.items()))}); "
                             f"took {dhindi}")
        else:
            dhindi = dname
            fallbacks.append({"level": "district", "id": did, "nameLatin": dname,
                              "reason": "no samiti's cover page yielded a Hindi district name"})
        panchayats = []
        for sid, sname, plist in samitis:
            slatin = _SAMITI_SUFFIX_RE.sub("", sname) or sname
            shindi = _hindi(cover(sid).get("samiti"))
            if shindi is None:
                shindi = slatin
                fallbacks.append({"level": "samiti", "id": sid, "nameLatin": slatin,
                                  "district": did, "reason": no_cover_reason(sid, "samiti")})
            counts["samitis"] += 1
            block = {"id": sid, "name": shindi, "nameLatin": slatin}
            for gp, gname, hindi, wards in plist:
                if hindi is None:
                    fallbacks.append({"level": "panchayat", "id": gp, "nameLatin": gname,
                                      "district": did,
                                      "reason": f"no Hindi {GP_COLUMN} cell in the Search grid"})
                panchayats.append({"id": gp, "name": hindi or gname, "nameLatin": gname,
                                   "block": dict(block), "wards": wards})
                counts["wards"] += len(wards)
                counts["wardsWithSupplement"] += sum(1 for w in wards if w["supplementUrl"])
        panchayats.sort(key=lambda p: (p["name"], p["nameLatin"], p["id"]))
        counts["districts"] += 1
        counts["panchayats"] += len(panchayats)
        fname = files_for[did]
        files[fname] = {"schemaVersion": SCHEMA_VERSION, "id": did, "name": dhindi,
                        "nameLatin": dname, "panchayats": panchayats}
        index_districts.append({"id": did, "name": dhindi, "nameLatin": dname, "file": fname,
                                "panchayatCount": len(panchayats)})
    summary = {"counts": counts, "skipped": skipped, "fallbacks": fallbacks, "notes": notes}
    if only_districts:
        summary["districtsBuilt"] = sorted(did for did, _n in districts)
    files[INDEX_FILE] = {
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE_PAGE,
        "pdfUrlTemplates": {
            "final": WARD_PDF_URL_TEMPLATE.replace("{ward:03d}", "{NNN}"),
            "supplement": SUPPLEMENT_PDF_URL_TEMPLATE.replace("{ward:03d}", "{NNN}"),
        },
        "districts": sort_index(index_districts),
        "summary": summary,
    }
    legacy_doc = {
        "schemaVersion": SCHEMA_VERSION,
        "generated_at": saved.meta().get("fetchedAt"),
        "source_page": SOURCE_PAGE,
        "ward_pdf_url_template": WARD_PDF_URL_TEMPLATE.replace("{ward:03d}", "{NNN}"),
        "notes": [
            f"Counts: {counts['districts']} districts; {counts['samitis']} rural panchayat "
            f"samitis walked; {skipped['urban']} urban bodies, {skipped['zillaParishad']} zilla "
            f"parishads and {skipped['other']} other entries skipped; {counts['panchayats']} "
            f"gram panchayats.",
            "kind is read from the portal's Latin name: 'urban' for nagar palika / parishad / "
            "nigam, 'rural' for panchayat samiti, 'unknown' otherwise. Only rural samitis list "
            "gram panchayats.",
            "Kept until the picker reads the sharded catalogue (catalogue/index.json, which "
            "also carries each panchayat's wards and Hindi names); see #122.",
        ],
        "districts": legacy,
    }
    return files, summary, errors, legacy_doc


def sort_index(districts):
    return sorted(districts, key=lambda d: (d["name"], d["nameLatin"], d["id"]))


def _dump(doc):
    return (json.dumps(doc, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def _write_atomic(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _load_versioned(path):
    """A JSON document this builder wrote earlier (a dict carrying
    schemaVersion and a districts list), or None for anything else."""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    if (isinstance(doc, dict) and "schemaVersion" in doc
            and isinstance(doc.get("districts"), list)
            and all(isinstance(d, dict) for d in doc["districts"])):
        return doc
    return None


def write_catalogue(out_dir, files, legacy_doc=None, legacy_path=None, partial=False):
    """Write the shards and then the index.

    A full build (partial false) replaces the catalogue and removes the
    shards an earlier index listed that this build no longer writes. A
    partial (--districts) build merges: districts it did not build keep their
    index entries, shards and older-catalogue entries, and only a rebuilt
    district's own old shard is removed if its name changed."""
    index_path = os.path.join(out_dir, INDEX_FILE)
    prev = _load_versioned(index_path)
    index = files[INDEX_FILE]
    built = {d["id"] for d in index["districts"]}
    remove = []
    if prev is not None:
        prev_files = {d.get("id"): d.get("file") for d in prev["districts"]}
        if partial:
            kept = [d for d in prev["districts"] if d.get("id") not in built]
            index = dict(index, districts=sort_index(kept + index["districts"]))
            remove = [f for i, f in prev_files.items() if i in built]
        else:
            remove = list(prev_files.values())
    for name in sorted(files):
        if name != INDEX_FILE:
            _write_atomic(os.path.join(out_dir, name), _dump(files[name]))
    _write_atomic(index_path, _dump(index))
    for name in remove:
        if (isinstance(name, str) and name not in files and name != INDEX_FILE
                and os.path.basename(name) == name and name.endswith(".json")):
            path = os.path.join(out_dir, name)
            if os.path.isfile(path):
                os.remove(path)
    if legacy_doc is not None and legacy_path:
        if partial:
            old = _load_versioned(legacy_path)
            if old is not None:
                fresh = {d["id"]: d for d in legacy_doc["districts"]}
                merged = [fresh.pop(d.get("id"), d) for d in old["districts"]]
                legacy_doc = dict(legacy_doc, districts=merged + list(fresh.values()),
                                  notes=old.get("notes", legacy_doc["notes"]))
        _write_atomic(legacy_path, _dump(legacy_doc))


def print_summary(summary, stream=None):
    stream = stream or sys.stderr
    c, s = summary["counts"], summary["skipped"]
    print(f"{c['districts']} districts, {c['samitis']} rural samitis, {c['panchayats']} gram "
          f"panchayats, {c['wards']} wards ({c['wardsWithSupplement']} with a supplement)",
          file=stream)
    print(f"skipped: {s['urban']} urban bodies, {s['zillaParishad']} zilla parishads, "
          f"{s['other']} other entries", file=stream)
    print(f"{len(summary['fallbacks'])} Hindi-name fallbacks to the Latin name", file=stream)
    for f in summary["fallbacks"]:
        print(f"  fallback: {f['level']} {f['nameLatin']} ({f['id']}): {f['reason']}", file=stream)
    for n in summary["notes"]:
        print(f"  note: {n}", file=stream)


class Fetcher:
    """Walks the portal into a directory of saved responses, skipping every
    response already saved there, so an interrupted run resumes."""

    def __init__(self, raw_dir, client, only_districts=None, interval=1.0, stream=None,
                 progress_every=25):
        self.saved = SavedResponses(raw_dir)
        self.client = client
        self.form = RollForm(client)
        self.only = only_districts or set()
        self.interval = interval
        self.stream = stream or sys.stderr
        self.progress_every = progress_every
        self.page0 = None
        self.live_districts = {}
        self.live_samiti = (None, None)
        self.started = time.monotonic()
        self.base = self._requests()
        self.total = 0.0
        self._last_report = 0

    def _requests(self):
        return sum(self.client.counts.values())

    def _save(self, name, raw):
        _write_atomic(self.saved.path(name), raw)

    def _live_page(self):
        if self.page0 is None:
            self.page0, raw = self.form.start()
            if not self.saved.has(PAGE_FILE):
                self._save(PAGE_FILE, raw)
        return self.page0

    def _live_district(self, did):
        if did not in self.live_districts:
            page, raw = self.form.select_district(self._live_page(), did)
            self.live_districts[did] = page
            if not self.saved.has(district_file(did)):
                self._save(district_file(did), raw)
        return self.live_districts[did]

    def _live_samiti_page(self, did, sid):
        if self.live_samiti[0] != (did, sid):
            page, raw = self.form.select_samiti(self._live_district(did), did, sid)
            self.live_samiti = ((did, sid), page)
            if not self.saved.has(samiti_file(did, sid)):
                self._save(samiti_file(did, sid), raw)
        return self.live_samiti[1]

    def _cover_done(self, sid):
        return self.saved.has(cover_file(sid)) or self.saved.has(cover_missing_file(sid))

    @staticmethod
    def _unknown_samiti_cost():
        return 1 + AVG_PANCHAYATS + 1

    def _samiti_cost(self, did, sid):
        if not self.saved.has(samiti_file(did, sid)):
            return self._unknown_samiti_cost()
        gps = self.saved.page(samiti_file(did, sid)).options(GP_FIELD)
        missing = sum(1 for gp, _n in gps if not self.saved.has(search_file(did, sid, gp)))
        return missing + (1 if missing else 0) + (0 if self._cover_done(sid) else 1)

    def _rural(self, did):
        return [(sid, n) for sid, n in self.saved.page(district_file(did)).options(PS_FIELD)
                if should_walk(n)]

    def _estimate(self, districts):
        total = 0.0
        for did, _n in districts:
            if not self.saved.has(district_file(did)):
                total += 1 + AVG_RURAL_SAMITIS * self._unknown_samiti_cost()
            else:
                total += sum(self._samiti_cost(did, sid) for sid, _n in self._rural(did))
        return total

    def _report(self, where, force=False):
        done = self._requests() - self.base
        if not force and done - self._last_report < self.progress_every:
            return
        self._last_report = done
        left = max(0, round(self.total - done))
        elapsed = time.monotonic() - self.started
        rate = elapsed / done if done >= 10 else self.interval + 0.5
        eta = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=left * rate)
        print(f"  [{done} requests, about {left} left, finish about "
              f"{eta.strftime('%Y-%m-%d %H:%M')} UTC] {where}", file=self.stream)

    def run(self):
        os.makedirs(self.saved.root, exist_ok=True)
        if not self.saved.has(META_FILE):
            self._save(META_FILE, _dump({"schemaVersion": SCHEMA_VERSION, "source": SOURCE_PAGE,
                                         "fetchedAt": now_iso()}))
        if not self.saved.has(PAGE_FILE):
            self._live_page()
        portal = self.saved.page(PAGE_FILE).options(DISTRICT_FIELD)
        districts = [(v, t) for v, t in portal if not self.only or v in self.only]
        unknown = sorted(self.only - {v for v, _t in portal})
        if unknown:
            raise InputError(f"--districts {','.join(unknown)}: no such district on the portal")
        self.total = self._estimate(districts)
        print(f"{len(districts)} districts; about {round(self.total)} requests to go at one "
              f"per {self.interval:g} s or slower", file=self.stream)
        for did, dname in districts:
            if not self.saved.has(district_file(did)):
                self._live_district(did)
                rural = self._rural(did)
                self.total += (len(rural) - AVG_RURAL_SAMITIS) * self._unknown_samiti_cost()
                self._report(f"{dname}: {len(rural)} rural samitis", force=True)
        for did, dname in districts:
            for sid, sname in self._rural(did):
                self._walk_samiti(did, dname, sid, sname)
        self._report("done", force=True)
        return 0

    def _walk_samiti(self, did, dname, sid, sname):
        where = f"{dname} / {sname}"
        if not self.saved.has(samiti_file(did, sid)):
            self._live_samiti_page(did, sid)
            n = len(self.saved.page(samiti_file(did, sid)).options(GP_FIELD))
            self.total += n - AVG_PANCHAYATS
        gps = self.saved.page(samiti_file(did, sid)).options(GP_FIELD)
        for k, (gp, gname) in enumerate(gps, 1):
            if self.saved.has(search_file(did, sid, gp)):
                continue
            _page, raw = self.form.search(self._live_samiti_page(did, sid), did, sid, gp)
            self._save(search_file(did, sid, gp), raw)
            self._report(f"{where}: {k}/{len(gps)} panchayats ({gname})")
        if not self._cover_done(sid):
            self._fetch_cover(did, sid, gps, where)
        self._report(f"{where}: done", force=True)

    def _fetch_cover(self, did, sid, gps, where):
        """Ward 1's Final PDF of the first panchayat, in dropdown order, whose
        grid lists ward 1 with a Final link and whose file the PDF host
        serves. When none does, cover-<S>.missing.json records what was tried
        so a resumed run does not ask again. A 403 or 429 still stops the run
        (PoliteClient raises Blocked)."""
        tried = []
        for gp, gname in gps:
            if not self.saved.has(search_file(did, sid, gp)):
                continue
            _grid, _names, rows = grid_wards(self.saved.page(search_file(did, sid, gp)))
            if not any(r["ward"].isdigit() and int(r["ward"]) == 1 and r["final"] for r in rows):
                continue
            url = pdf_url(WARD_PDF_URL_TEMPLATE, sid, gname, 1)
            status, _headers, body = self.client.request(url, accept_redirect=True)
            if status == 200 and body.startswith(b"%PDF-"):
                self._save(cover_file(sid), body)
                return
            tried.append({"url": url, "status": status, "bytes": len(body)})
            print(f"  {where}: cover {url} answered {status}, {len(body)} bytes", file=self.stream)
        self._save(cover_missing_file(sid), _dump({
            "schemaVersion": SCHEMA_VERSION, "samiti": sid, "at": now_iso(), "tried": tried}))
        print(f"  {where}: no cover PDF; the build will use Latin names for it "
              f"(delete {cover_missing_file(sid)} to try again)", file=self.stream)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--input", help="build from this directory of saved responses (no network)")
    src.add_argument("--fetch", help="walk the portal into this directory (resuming from what "
                                     "is saved there), then build from it if --out is given")
    p.add_argument("--out", help="output directory, e.g. data/sec/catalogue")
    p.add_argument("--legacy-out", help="also write the older single-file catalogue here "
                                        "(default: not written; the app reads only the shards)")
    p.add_argument("--no-legacy", action="store_true",
                   help="do not write the older catalogue (the default; kept for old scripts)")
    p.add_argument("--districts", help="comma-separated district ids (default: all); with --out "
                                       "the named districts are merged into the existing catalogue")
    p.add_argument("--allow-latin-names", action="store_true",
                   help="build even without node, which reads the covers: every district and "
                        "samiti name then falls back to Latin")
    p.add_argument("--interval", type=float, default=1.0,
                   help="minimum seconds between one request ending and the next starting")
    p.add_argument("--log", help="append one JSON line per request here (--fetch)")
    args = p.parse_args(argv)
    if args.interval < 1.0:
        p.error("--interval below 1.0 s is not allowed")
    if args.input and not args.out:
        p.error("--input needs --out")
    only = set(filter(None, (args.districts or "").split(",")))
    if args.out and not args.allow_latin_names and not node_available():
        print("FAILED: node was not found, so no cover page can be read and every district "
              "and samiti would get its Latin name. Install Node.js, or pass "
              "--allow-latin-names to build with Latin names anyway.", file=sys.stderr)
        return 1
    if args.fetch:
        client = PoliteClient(interval=args.interval, log_path=args.log)
        try:
            Fetcher(args.fetch, client, only, interval=args.interval).run()
        except (Blocked, UnexpectedResponse) as exc:
            print(f"STOPPED: {exc}", file=sys.stderr)
            print("What is saved stays saved; run the same command again to resume.",
                  file=sys.stderr)
            return 2
        except InputError as exc:
            print(f"FAILED: {exc}", file=sys.stderr)
            return 1
        finally:
            print(json.dumps({"requests": client.counts}), file=sys.stderr)
        if not args.out:
            return 0
    try:
        files, summary, errors, legacy_doc = build_catalogue(args.input or args.fetch, only)
    except (UnexpectedResponse, InputError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    if errors:
        for e in errors:
            print(f"FAILED: {e}", file=sys.stderr)
        print(f"{len(errors)} failures; nothing written", file=sys.stderr)
        return 1
    legacy_path = None if args.no_legacy else args.legacy_out
    write_catalogue(args.out, files, legacy_doc, legacy_path, partial=bool(only))
    print_summary(summary)
    if not node_available():
        print("WARNING: node was not found; every district and samiti name is Latin "
              "(--allow-latin-names)", file=sys.stderr)
    print(f"wrote {len(files)} files to {args.out}"
          + (f" and {legacy_path}" if legacy_path else "")
          + (f" (merged districts {','.join(sorted(only))})" if only else ""), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
