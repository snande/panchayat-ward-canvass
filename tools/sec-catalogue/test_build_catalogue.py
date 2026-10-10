"""Tests for build_catalogue.py against fixtures/sec/catalogue-input/, the saved
responses for the five fixture panchayats. Standard library only; reading the
cover pages needs `node` (CI sets up Node 20). No network: live mode runs
against a fake portal that serves the saved responses.

    python3 -m unittest discover -s tools/sec-catalogue -p 'test_*.py'
"""

import contextlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import urllib.parse
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_catalogue as bc  # noqa: E402 - the sibling module is found via the line above
from make_test_input import form_page, grid_html  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
FIXTURE = os.path.join(REPO, "fixtures", "sec", "catalogue-input")
with open(os.path.join(REPO, "fixtures", "sec", "manifest.json"), encoding="utf-8") as _fh:
    MANIFEST = json.load(_fh)

# What each fixture samiti's cover page prints (src/decoder/rollCover.test.js
# holds the decoder to the same readings).
COVERS = {
    "6": ("भरतपुर", "नदबई"),
    "7": ("भीलवाडा", "माण्डल"),
    "8": ("बीकानेर", "कोलायत"),
    "22": ("जोधपुर", "ओसियाँ"),
    "33": ("उदयपुर", "गिर्वा"),
}


def run(argv):
    """main(argv) -> (exit status, stderr text)."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        status = bc.main(argv)
    return status, err.getvalue()


def read_tree(root):
    out = {}
    for base, _dirs, names in os.walk(root):
        for name in names:
            path = os.path.join(base, name)
            with open(path, "rb") as fh:
                out[os.path.relpath(path, root)] = fh.read()
    return out


def saved_responses(root):
    """read_tree minus the fixture directory's README."""
    return {k: v for k, v in read_tree(root).items() if k != "README.md"}


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sec-catalogue-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def build(self, input_dir=FIXTURE, name="out"):
        out = os.path.join(self.tmp, name, "catalogue")
        status, err = run(["--input", input_dir, "--out", out])
        return out, status, err

    def copy_fixture(self):
        dst = os.path.join(self.tmp, "input")
        shutil.copytree(FIXTURE, dst)
        return dst


class OfflineBuild(Tmp):
    def test_writes_index_and_one_file_per_district_with_schema_version(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        index = load(os.path.join(out, "index.json"))
        self.assertIsInstance(index["schemaVersion"], int)
        self.assertEqual(len(index["districts"]), 5)
        for d in index["districts"]:
            self.assertEqual(set(d), {"id", "name", "nameLatin", "file", "panchayatCount"})
            doc = load(os.path.join(out, d["file"]))
            self.assertEqual(doc["schemaVersion"], index["schemaVersion"])
            self.assertEqual(doc["id"], d["id"])
            self.assertEqual(len(doc["panchayats"]), d["panchayatCount"])
            for p in doc["panchayats"]:
                self.assertEqual(set(p), {"id", "name", "nameLatin", "block", "wards"})
                self.assertEqual(set(p["block"]), {"id", "name", "nameLatin"})
                self.assertTrue(p["wards"])
                for w in p["wards"]:
                    self.assertEqual(set(w), {"ward", "pdfUrl", "supplementUrl"})
                    self.assertIsInstance(w["ward"], int)
                    self.assertTrue(w["pdfUrl"])
        self.assertEqual(sorted(os.listdir(out)),
                         sorted(["index.json"] + [d["file"] for d in index["districts"]]))

    def test_every_file_written_carries_schema_version(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        written = [os.path.join(out, n) for n in os.listdir(out)] + [out + ".json"]
        for path in written:
            self.assertIsInstance(load(path).get("schemaVersion"), int, path)

    def test_hindi_names_come_from_the_search_grid_and_the_covers(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        index = load(os.path.join(out, "index.json"))
        self.assertEqual(index["summary"]["fallbacks"], [])
        by_id = {d["id"]: d for d in index["districts"]}
        for entry in MANIFEST["panchayats"]:
            did, sid = entry["district"]["id"], entry["samiti"]["id"]
            district_hi, samiti_hi = COVERS[did]
            self.assertEqual(by_id[did]["name"], district_hi)
            self.assertEqual(by_id[did]["nameLatin"], entry["district"]["name"])
            doc = load(os.path.join(out, by_id[did]["file"]))
            self.assertEqual(doc["name"], district_hi)
            (p,) = doc["panchayats"]
            self.assertEqual(p["id"], entry["panchayat"]["id"])
            self.assertEqual(p["name"], entry["search_ward_rows"][0][0])
            self.assertEqual(p["nameLatin"], entry["panchayat"]["name"])
            self.assertEqual(p["block"], {"id": sid, "name": samiti_hi,
                                          "nameLatin": entry["samiti"]["name"].replace(
                                              " PANCHAYAT SAMITI", "")})

    def test_ward_urls_follow_the_two_templates_the_portal_resolved(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        index = load(os.path.join(out, "index.json"))
        files = {d["id"]: d["file"] for d in index["districts"]}
        for entry in MANIFEST["panchayats"]:
            (p,) = load(os.path.join(out, files[entry["district"]["id"]]))["panchayats"]
            self.assertEqual([w["ward"] for w in p["wards"]],
                             [int(r[1]) for r in entry["search_ward_rows"]])
            cols = entry["pdf_columns"]
            for w in p["wards"]:
                n = f"{w['ward']:03d}"
                self.assertEqual(w["pdfUrl"], cols["Final PDF"]["url_template"].replace("{NNN}", n))
                self.assertEqual(w["supplementUrl"],
                                 cols["Final With Supp-2 PDF"]["url_template"].replace("{NNN}", n))
        bhilwara = load(os.path.join(out, files["7"]))
        almas1 = bhilwara["panchayats"][0]["wards"][0]
        self.assertEqual(almas1["ward"], 1)
        self.assertEqual(almas1["supplementUrl"], "https://esuchiroll.rajasthan.gov.in/"
                         "Publication_PDF_2026/PRI/Supplement/60/ALMAS-Ward%20No-001.pdf")

    def test_two_runs_over_the_same_input_are_byte_identical(self):
        out1, s1, e1 = self.build(name="one")
        out2, s2, e2 = self.build(name="two")
        self.assertEqual((s1, s2), (0, 0), e1 + e2)
        self.assertEqual(read_tree(os.path.dirname(out1)), read_tree(os.path.dirname(out2)))

    def test_only_rural_wards_are_emitted_and_skipped_entries_are_counted(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        index = load(os.path.join(out, "index.json"))
        self.assertEqual(index["summary"]["skipped"], {"urban": 38, "zillaParishad": 5, "other": 2})
        self.assertIn("skipped: 38 urban bodies, 5 zilla parishads, 2 other entries", err)
        rural = {e["samiti"]["id"] for e in MANIFEST["panchayats"]}
        for d in index["districts"]:
            for p in load(os.path.join(out, d["file"]))["panchayats"]:
                self.assertIn(p["block"]["id"], rural)

    def test_keeps_writing_the_older_single_file_catalogue(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        legacy = load(out + ".json")
        self.assertEqual({"schemaVersion", "generated_at", "source_page", "ward_pdf_url_template",
                          "notes", "districts"}, set(legacy))
        bhilwara = next(d for d in legacy["districts"] if d["id"] == "7")
        mandal = next(s for s in bhilwara["samitis"] if s["id"] == "60")
        self.assertEqual(mandal["kind"], "rural")
        self.assertEqual(mandal["panchayats"], [{"id": "2610", "name": "Almas"}])
        self.assertIn("urban", {s["kind"] for s in bhilwara["samitis"]})

    def test_a_cover_that_cannot_be_read_falls_back_to_the_latin_name_without_failing(self):
        src = self.copy_fixture()
        os.remove(os.path.join(src, "cover-60.pdf"))
        with open(os.path.join(src, "cover-69.pdf"), "wb") as fh:
            fh.write(b"not a pdf")
        out, status, err = self.build(src)
        self.assertEqual(status, 0, err)
        index = load(os.path.join(out, "index.json"))
        by_id = {d["id"]: d for d in index["districts"]}
        self.assertEqual(by_id["7"]["name"], "BHILWARA")
        self.assertEqual(by_id["8"]["name"], "BIKANER")
        self.assertEqual(by_id["22"]["name"], "जोधपुर")
        p = load(os.path.join(out, by_id["7"]["file"]))["panchayats"][0]
        self.assertEqual(p["block"]["name"], "MANDAL")
        self.assertEqual(p["name"], "आलमास")
        fallbacks = {(f["level"], f["id"]) for f in index["summary"]["fallbacks"]}
        self.assertEqual(fallbacks, {("district", "7"), ("samiti", "60"),
                                     ("district", "8"), ("samiti", "69")})
        self.assertIn("4 Hindi-name fallbacks", err)
        self.assertIn("fallback: district BHILWARA (7)", err)
        self.assertIn("fallback: samiti MANDAL (60)", err)

    def test_panchayats_sort_by_hindi_name_and_wards_by_number(self):
        src = self.copy_fixture()
        districts = [("7", "BHILWARA")]
        samitis = [("60", "MANDAL PANCHAYAT SAMITI")]
        # Test-only panchayats beside Almas: grid rows listed out of order.
        extra = [("9001", "Zeta", "अजमा", ["3", "1", "2"]), ("9002", "Alpha", "हरिपुर", ["2", "1"])]
        gps = [("2610", "Almas")] + [(g, n) for g, n, _h, _w in extra]
        with open(os.path.join(src, bc.samiti_file("7", "60")), "w", encoding="utf-8") as fh:
            fh.write(form_page("samiti", districts, "7", samitis, "60", gps))
        cols = ["Grampanchayat", "Ward No.", "Final PDF", "Final With Supp-2 PDF"]
        for gp, _name, hindi, wards in extra:
            grid = grid_html(cols, [[hindi, w, "", ""] for w in wards], {"Final PDF": "lnkFinal"})
            with open(os.path.join(src, bc.search_file("7", "60", gp)), "w", encoding="utf-8") as fh:
                fh.write(form_page("search", districts, "7", samitis, "60", gps, gp, grid))
        out, status, err = self.build(src)
        self.assertEqual(status, 0, err)
        doc = load(os.path.join(out, "bhilwara.json"))
        self.assertEqual([p["name"] for p in doc["panchayats"]], ["अजमा", "आलमास", "हरिपुर"])
        for p in doc["panchayats"]:
            self.assertEqual([w["ward"] for w in p["wards"]], sorted(w["ward"] for w in p["wards"]))
        zeta = doc["panchayats"][0]
        self.assertEqual([w["supplementUrl"] for w in zeta["wards"]], [None, None, None])
        self.assertEqual(zeta["wards"][0]["pdfUrl"], "https://esuchiroll.rajasthan.gov.in/"
                         "Publication_PDF_2026/PRI/Final/60/ZETA-Ward%20No-001.pdf")


class BuildFailures(Tmp):
    ALMAS = bc.search_file("7", "60", "2610")

    def edit_almas(self, edit):
        src = self.copy_fixture()
        path = os.path.join(src, self.ALMAS)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        new = edit(text)
        self.assertNotEqual(new, text)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new)
        return src

    def assert_fails(self, src, reason):
        out, status, err = self.build(src)
        self.assertNotEqual(status, 0)
        self.assertIn("district BHILWARA (7) / panchayat Almas (2610)", err)
        self.assertRegex(err, reason)
        self.assertFalse(os.path.exists(out))
        self.assertFalse(os.path.exists(out + ".json"))

    @staticmethod
    def rows(text):
        return re.findall(r"<tr><td>.*?</tr>", text)

    def test_a_panchayat_with_zero_wards_fails(self):
        src = self.edit_almas(lambda t: re.sub(r"<tr><td>.*?</tr>\n?", "", t))
        self.assert_fails(src, "zero wards")

    def test_a_missing_search_response_fails_as_zero_wards(self):
        src = self.copy_fixture()
        os.remove(os.path.join(src, self.ALMAS))
        self.assert_fails(src, "no wards")

    def test_a_ward_without_a_final_pdf_link_fails(self):
        def drop_final(text):
            row = self.rows(text)[2]
            return text.replace(row, re.sub(r"<td><a [^>]*lnkFinal[^>]*>.*?</a></td>",
                                            "<td></td>", row))
        self.assert_fails(self.edit_almas(drop_final), "ward 3 has no Final PDF link, so no pdfUrl")

    def test_a_repeated_ward_number_fails(self):
        def repeat(text):
            row = self.rows(text)[3]
            return text.replace(row, row.replace("<td>4</td>", "<td>3</td>"))
        self.assert_fails(self.edit_almas(repeat), "ward 3 repeats")


class FakePortal:
    """Stands in for PoliteClient: answers the roll page's GET and posts and
    the PDF host's GETs from a directory of saved responses."""

    def __init__(self, saved_dir, stop_after=None):
        self.saved = saved_dir
        self.counts = {}
        self.searches = []
        self.stop_after = stop_after

    def _file(self, name):
        with open(os.path.join(self.saved, name), "rb") as fh:
            return fh.read()

    def request(self, url, data=None, accept_redirect=False):
        host = urllib.parse.urlsplit(url).hostname
        self.counts[host] = self.counts.get(host, 0) + 1
        if self.stop_after is not None and sum(self.counts.values()) > self.stop_after:
            raise bc.Blocked("fake portal: interrupted")
        if url == bc.SOURCE_PAGE and data is None:
            return 200, {}, self._file(bc.PAGE_FILE)
        if url == bc.SOURCE_PAGE:
            did, sid = data.get(bc.DISTRICT_FIELD), data.get(bc.PS_FIELD)
            if bc.SEARCH_FIELD in data:
                self.searches.append(data[bc.GP_FIELD])
                return 200, {}, self._file(bc.search_file(did, sid, data[bc.GP_FIELD]))
            if data["__EVENTTARGET"] == bc.DISTRICT_FIELD:
                return 200, {}, self._file(bc.district_file(did))
            if data["__EVENTTARGET"] == bc.PS_FIELD:
                return 200, {}, self._file(bc.samiti_file(did, sid))
        m = re.search(r"/PRI/Final/(\d+)/[^/]+-Ward%20No-001\.pdf$", url)
        if host == "esuchiroll.rajasthan.gov.in" and m:
            return 200, {}, self._file(bc.cover_file(m.group(1)))
        return 302, {"Location": "https://esuchiroll.rajasthan.gov.in/ErrorPage.aspx"}, b""


class LiveMode(Tmp):
    def fetch(self, raw, client):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                status = bc.Fetcher(raw, client, progress_every=1).run()
            except bc.Blocked:
                status = 2
        return status, err.getvalue()

    def test_saves_every_response_then_builds_the_same_catalogue(self):
        raw = os.path.join(self.tmp, "raw")
        status, err = self.fetch(raw, FakePortal(FIXTURE))
        self.assertEqual(status, 0, err)
        self.assertRegex(err, r"about \d+ left, finish about \d{4}-\d\d-\d\d \d\d:\d\d UTC")
        got, want = read_tree(raw), saved_responses(FIXTURE)
        self.assertEqual(sorted(got), sorted(want))
        for name in want:
            if name != bc.META_FILE:
                self.assertEqual(got[name], want[name], name)
        self.assertEqual(load(os.path.join(raw, bc.META_FILE))["schemaVersion"], bc.SCHEMA_VERSION)
        out_live, s1, e1 = self.build(raw, "live")
        out_fix, s2, e2 = self.build(FIXTURE, "fixture")
        self.assertEqual((s1, s2), (0, 0), e1 + e2)
        self.assertEqual(read_tree(out_live), read_tree(out_fix))

    def test_an_interrupted_run_resumes_from_what_is_saved(self):
        raw = os.path.join(self.tmp, "raw")
        full = FakePortal(FIXTURE)
        self.assertEqual(self.fetch(os.path.join(self.tmp, "once"), full)[0], 0)
        first = FakePortal(FIXTURE, stop_after=14)
        self.assertEqual(self.fetch(raw, first)[0], 2)
        second = FakePortal(FIXTURE)
        status, err = self.fetch(raw, second)
        self.assertEqual(status, 0, err)
        # No Search is posted twice across the two runs.
        self.assertEqual(sorted(first.searches + second.searches), sorted(full.searches))
        self.assertLess(sum(second.counts.values()), sum(full.counts.values()))
        self.assertEqual(sorted(read_tree(raw)), sorted(saved_responses(FIXTURE)))
        # A finished run asks for nothing more.
        third = FakePortal(FIXTURE)
        self.assertEqual(self.fetch(raw, third)[0], 0)
        self.assertEqual(third.counts, {})

    def test_reads_no_file_outside_the_saved_responses_and_writes_only_its_outputs(self):
        raw = os.path.realpath(os.path.join(self.tmp, "raw"))
        out = os.path.realpath(os.path.join(self.tmp, "built", "catalogue"))
        opened = []
        real_open = open

        def spy(path, mode="r", *args, **kwargs):
            opened.append((os.path.realpath(path), mode))
            return real_open(path, mode, *args, **kwargs)

        portal = FakePortal(FIXTURE)
        with mock.patch.object(bc, "PoliteClient", lambda **kw: portal), \
                mock.patch.object(bc, "open", spy, create=True):
            status, err = run(["--fetch", raw, "--out", out])
        self.assertEqual(status, 0, err)
        self.assertTrue(opened)
        for path, mode in opened:
            inside = [root for root in (raw, out, out + ".json")
                      if path == root or path.startswith(root + os.sep)
                      or path.startswith(root + ".tmp")]
            self.assertTrue(inside, f"opened {path} ({mode})")
            if "r" in mode and "+" not in mode:
                self.assertTrue(path.startswith(raw + os.sep) or path.startswith(out + os.sep),
                                f"read {path}")

    def test_waits_at_least_the_interval_between_requests_to_a_host(self):
        client = bc.PoliteClient(interval=1.0)
        client._last_end["sec.rajasthan.gov.in"] = 100.0
        slept = []
        with mock.patch.object(bc.time, "monotonic", return_value=100.25), \
                mock.patch.object(bc.time, "sleep", slept.append):
            client._wait("sec.rajasthan.gov.in")
        self.assertEqual(slept, [0.75])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            bc.main(["--fetch", self.tmp, "--interval", "0.5"])


if __name__ == "__main__":
    unittest.main()
