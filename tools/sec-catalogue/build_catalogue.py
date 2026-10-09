#!/usr/bin/env python3
"""Build data/sec/catalogue.json: every district, panchayat samiti / urban
body and gram panchayat the State Election Commission of Rajasthan lists on
its roll download page.

The page (https://sec.rajasthan.gov.in/se_pdfdownload.aspx) is an ASP.NET
WebForms form with three cascading dropdowns. Each dropdown change is a POST
that carries the page's __VIEWSTATE and __EVENTVALIDATION back to the server,
so the walk replays those posts:

  1 GET of the page            -> the district list
  1 POST per district          -> that district's samitis and urban bodies
  1 POST per walked samiti     -> that samiti's gram panchayats

Only rural panchayat samitis are walked: an urban body's third dropdown lists
municipal wards, not gram panchayats. This script never posts Search, so no
ward list is fetched here; a panchayat's wards are found at use time by
probing ward numbers against the PDF URL template (a missing ward answers
302). See docs/research/sec-statewide-catalogue.md.

Standard library only. It must run from a networked machine: the swarm's
Engineer sandbox cannot reach the commission's servers.

    python3 tools/sec-catalogue/build_catalogue.py
    python3 tools/sec-catalogue/build_catalogue.py --districts 17 --out /tmp/jaipur.json

Politeness: one request at a time, at least --interval seconds (default 1.0)
between the end of one request and the start of the next, a descriptive
User-Agent, exponential backoff on network errors and 5xx, and an immediate
stop on 403, 429, a redirect, or a response that is not the expected form
(anything that looks like blocking or a captcha). --max-posts caps the run.
"""

import argparse
import datetime as _dt
import http.cookiejar
import json
import os
import re
import sys
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


def _save_raw(raw_dir, name, raw):
    if raw_dir:
        os.makedirs(raw_dir, exist_ok=True)
        with open(os.path.join(raw_dir, name), "wb") as fh:
            fh.write(raw)


def _load_checkpoint(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {"districts": {}, "samitis": {}}


def _save_checkpoint(path, state):
    if path:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False)
        os.replace(tmp, path)


def build(args):
    client = PoliteClient(interval=args.interval, log_path=args.log)
    form = RollForm(client)
    state = _load_checkpoint(args.checkpoint)
    only_districts = set(filter(None, (args.districts or "").split(",")))
    only_samitis = set(filter(None, (args.samitis or "").split(",")))

    page0, raw = form.start()
    _save_raw(args.raw_dir, "page.html", raw)
    districts = [(v, t) for v, t in page0.options(DISTRICT_FIELD)
                 if not only_districts or v in only_districts]
    print(f"{len(districts)} districts", file=sys.stderr)

    district_pages = {}
    for did, dname in districts:
        if did in state["districts"]:
            continue
        page, raw = form.select_district(page0, did)
        _save_raw(args.raw_dir, f"district-{did}.html", raw)
        district_pages[did] = page
        state["districts"][did] = {"name": dname, "samitis": page.options(PS_FIELD)}
        _save_checkpoint(args.checkpoint, state)
        print(f"  {dname}: {len(state['districts'][did]['samitis'])} samitis/urban bodies",
              file=sys.stderr)

    to_walk = []
    for did, _dname in districts:
        for sid, sname in state["districts"][did]["samitis"]:
            if only_samitis and sid not in only_samitis:
                continue
            if (only_samitis or should_walk(sname)) and f"{did}/{sid}" not in state["samitis"]:
                to_walk.append((did, sid, sname))
    redo_districts = {did for did, _sid, _n in to_walk if did not in district_pages}
    planned = form.posts + len(to_walk) + len(redo_districts)
    print(f"{form.posts} posts so far; walking {len(to_walk)} samitis needs {planned} in total "
          f"(cap {args.max_posts})", file=sys.stderr)
    walked = planned <= args.max_posts
    if not walked:
        print("over the post cap: writing districts and samitis only", file=sys.stderr)
    else:
        for did, sid, sname in to_walk:
            if did not in district_pages:
                district_pages[did], _raw = form.select_district(page0, did)
            page, raw = form.select_samiti(district_pages[did], did, sid)
            _save_raw(args.raw_dir, f"samiti-{did}-{sid}.html", raw)
            state["samitis"][f"{did}/{sid}"] = page.options(GP_FIELD)
            _save_checkpoint(args.checkpoint, state)
            print(f"  {sname}: {len(state['samitis'][f'{did}/{sid}'])} panchayats", file=sys.stderr)

    out_districts = []
    counts = {"districts": 0, "samitis": 0, "rural": 0, "urban": 0, "unknown": 0,
              "walked": 0, "panchayats": 0}
    for did, dname in districts:
        samitis = []
        for sid, sname in state["districts"][did]["samitis"]:
            kind = kind_of(sname)
            counts["samitis"] += 1
            counts[kind] += 1
            panchayats = state["samitis"].get(f"{did}/{sid}")
            if panchayats is not None:
                counts["walked"] += 1
                counts["panchayats"] += len(panchayats)
            samitis.append({"id": sid, "name": sname, "kind": kind,
                            "panchayats": [{"id": p, "name": n} for p, n in panchayats or []]})
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
        "Ward lists are not stored. A panchayat's wards are found by requesting ward 001, 002, "
        "... from ward_pdf_url_template until one answers 302 (a 173-byte HTML error page). "
        "PANCHAYAT_NAME is the panchayat's name exactly as listed here, upper-cased, with "
        "spaces percent-encoded.",
        f"Requests: {sum(client.counts.values())} to sec.rajasthan.gov.in "
        f"({form.posts} form posts), at most one per {args.interval:g} s.",
    ]
    if not walked:
        notes.insert(1, f"INCOMPLETE: walking every samiti needed {planned} posts, over the "
                        f"cap of {args.max_posts}; panchayat lists were not fetched.")
    catalogue = {
        "generated_at": now_iso(),
        "source_page": SOURCE_PAGE,
        "ward_pdf_url_template": WARD_PDF_URL_TEMPLATE.replace("{ward:03d}", "{NNN}"),
        "notes": notes,
        "districts": out_districts,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(catalogue, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(json.dumps({"counts": counts, "requests": client.counts, "posts": form.posts}),
          file=sys.stderr)
    return 0 if walked else 3


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--out", default=os.path.join(repo, "data", "sec", "catalogue.json"))
    p.add_argument("--interval", type=float, default=1.0,
                   help="minimum seconds between one request ending and the next starting")
    p.add_argument("--max-posts", type=int, default=450,
                   help="write districts and samitis only if walking would need more posts")
    p.add_argument("--districts", help="comma-separated district ids (default: all)")
    p.add_argument("--samitis", help="comma-separated samiti ids to walk, whatever their kind")
    p.add_argument("--checkpoint", help="JSON file to resume an interrupted run from")
    p.add_argument("--raw-dir", help="save every response body here")
    p.add_argument("--log", help="append one JSON line per request here")
    args = p.parse_args(argv)
    if args.interval < 1.0:
        p.error("--interval below 1.0 s is not allowed")
    try:
        return build(args)
    except (Blocked, UnexpectedResponse) as exc:
        print(f"STOPPED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
