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
COLUMNS = ["Grampanchayat", "Ward No.", "Final PDF", "Final With Supp-2 PDF"]
BHILWARA = [("7", "BHILWARA")]
MANDAL = [("60", "MANDAL PANCHAYAT SAMITI")]
FINAL_URL = "https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/"


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


def write(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sec-catalogue-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def build(self, input_dir=FIXTURE, name="out", extra=()):
        out = os.path.join(self.tmp, name, "catalogue")
        status, err = run(["--input", input_dir, "--out", out, *extra])
        return out, status, err

    def copy_fixture(self):
        dst = os.path.join(self.tmp, "input")
        shutil.copytree(FIXTURE, dst)
        return dst

    @staticmethod
    def add_panchayats(src, extra, samitis=MANDAL, sid="60"):
        """Add test-only panchayats (gp, Latin name, [grid rows]) to a samiti
        of a copied Bhilwara input, beside the samiti's existing ones."""
        path = os.path.join(src, bc.samiti_file("7", sid))
        gps = []
        if os.path.exists(path):
            with open(path, "rb") as fh:
                gps = bc.parse_page(fh.read(), "samiti").options(bc.GP_FIELD)
        gps = gps + [(g, n) for g, n, _rows in extra]
        write(path, form_page("samiti", BHILWARA, "7", samitis, sid, gps))
        for gp, _name, rows in extra:
            grid = grid_html(COLUMNS, rows, {"Final PDF": "lnkFinal"})
            write(os.path.join(src, bc.search_file("7", sid, gp)),
                  form_page("search", BHILWARA, "7", samitis, sid, gps, gp, grid))


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
        out, status, err = self.build(extra=("--legacy-out", os.path.join(self.tmp, "out", "catalogue.json")))
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

    def test_a_name_with_spaces_or_dots_is_upper_cased_and_percent_encoded_in_the_url(self):
        # Chaksu's dropdown lists 'Dhunsari-Rupwas Mukhayalya Dhunsari'
        # (docs/research/sec-statewide-catalogue.md, section 7).
        src = self.copy_fixture()
        self.add_panchayats(src, [
            ("9001", "Dhunsari-Rupwas Mukhayalya Dhunsari", [["धूनसरी", "1", "", ""]]),
            ("9002", "St. Ram Nagar", [["रामनगर", "2", "", ""]]),
        ])
        out, status, err = self.build(src)
        self.assertEqual(status, 0, err)
        urls = {p["id"]: p["wards"][0]["pdfUrl"]
                for p in load(os.path.join(out, "bhilwara.json"))["panchayats"]}
        self.assertEqual(urls["9001"], FINAL_URL + "60/DHUNSARI-RUPWAS%20MUKHAYALYA%20DHUNSARI"
                                                   "-Ward%20No-001.pdf")
        self.assertEqual(urls["9002"], FINAL_URL + "60/ST.%20RAM%20NAGAR-Ward%20No-002.pdf")

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

    def test_writes_the_older_single_file_catalogue_when_asked(self):
        out, status, err = self.build(extra=("--legacy-out", os.path.join(self.tmp, "out", "catalogue.json")))
        self.assertEqual(status, 0, err)
        legacy = load(out + ".json")
        self.assertEqual({"schemaVersion", "generated_at", "source_page", "ward_pdf_url_template",
                          "notes", "districts"}, set(legacy))
        bhilwara = next(d for d in legacy["districts"] if d["id"] == "7")
        mandal = next(s for s in bhilwara["samitis"] if s["id"] == "60")
        self.assertEqual(mandal["kind"], "rural")
        self.assertEqual(mandal["panchayats"], [{"id": "2610", "name": "Almas"}])
        self.assertIn("urban", {s["kind"] for s in bhilwara["samitis"]})

    def test_by_default_no_older_catalogue_is_written(self):
        # The app reads only the shards (#122): --out data/sec/catalogue no
        # longer writes data/sec/catalogue.json beside it.
        root = os.path.join(self.tmp, "data", "sec")
        status, err = run(["--input", FIXTURE, "--out", os.path.join(root, "catalogue")])
        self.assertEqual(status, 0, err)
        self.assertEqual(sorted(os.listdir(root)), ["catalogue"])
        self.assertNotIn("catalogue.json", err)

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

    def test_covers_that_disagree_on_the_district_take_the_majority_and_say_so(self):
        src = self.copy_fixture()
        samitis = MANDAL + [("9060", "TESTA PANCHAYAT SAMITI"), ("9061", "TESTB PANCHAYAT SAMITI")]
        write(os.path.join(src, bc.district_file("7")), form_page("district", BHILWARA, "7", samitis))
        for sid, gp in (("9060", "9160"), ("9061", "9161")):
            self.add_panchayats(src, [(gp, f"Test{gp}", [["परीक्षा", "1", "", ""]])],
                                samitis=samitis, sid=sid)
            with open(os.path.join(src, bc.cover_file(sid)), "wb") as fh:
                fh.write(b"%PDF-stub")
        stub = {"cover-60.pdf": {"district": "भीलवाडा", "samiti": "माण्डल"},
                "cover-9060.pdf": {"district": "भीलवाड़ा", "samiti": "परीक्षा"},
                "cover-9061.pdf": {"district": "भीलवाड़ा", "samiti": None}}
        seen = []

        def reader(paths):
            seen.extend(paths)
            return {p: stub.get(os.path.basename(p), {"district": None, "samiti": None})
                    for p in paths}

        files, summary, errors, _legacy = bc.build_catalogue(src, {"7"}, cover_reader=reader)
        self.assertEqual(errors, [])
        self.assertEqual(len(seen), 3)
        doc = files["bhilwara.json"]
        self.assertEqual(doc["name"], "भीलवाड़ा")
        self.assertEqual(files["index.json"]["districts"][0]["name"], "भीलवाड़ा")
        (note,) = summary["notes"]
        self.assertIn("district BHILWARA (7): covers disagree", note)
        self.assertIn("took भीलवाड़ा", note)
        blocks = {p["block"]["id"]: p["block"] for p in doc["panchayats"]}
        self.assertEqual(blocks["9060"]["name"], "परीक्षा")
        self.assertEqual(blocks["9061"], {"id": "9061", "name": "TESTB", "nameLatin": "TESTB"})
        self.assertEqual(summary["fallbacks"], [{
            "level": "samiti", "id": "9061", "nameLatin": "TESTB", "district": "7",
            "reason": "no Hindi samiti name read from cover-9061.pdf"}])

    def test_panchayats_sort_by_hindi_name_and_wards_by_number(self):
        src = self.copy_fixture()
        self.add_panchayats(src, [
            ("9001", "Zeta", [["अजमा", w, "", ""] for w in ("3", "1", "2")]),
            ("9002", "Alpha", [["हरिपुर", w, "", ""] for w in ("2", "1")]),
        ])
        out, status, err = self.build(src)
        self.assertEqual(status, 0, err)
        doc = load(os.path.join(out, "bhilwara.json"))
        self.assertEqual([p["name"] for p in doc["panchayats"]], ["अजमा", "आलमास", "हरिपुर"])
        for p in doc["panchayats"]:
            self.assertEqual([w["ward"] for w in p["wards"]], sorted(w["ward"] for w in p["wards"]))
        zeta = doc["panchayats"][0]
        self.assertEqual([w["supplementUrl"] for w in zeta["wards"]], [None, None, None])
        self.assertEqual(zeta["wards"][0]["pdfUrl"], FINAL_URL + "60/ZETA-Ward%20No-001.pdf")

    def test_without_node_the_build_stops_unless_latin_names_are_allowed(self):
        with mock.patch.object(bc.shutil, "which", return_value=None):
            out, status, err = self.build()
            self.assertEqual(status, 1)
            self.assertIn("node was not found", err)
            self.assertFalse(os.path.exists(out))
            out, status, err = self.build(name="latin", extra=["--allow-latin-names"])
        self.assertEqual(status, 0, err)
        self.assertIn("WARNING: node was not found", err)
        index = load(os.path.join(out, "index.json"))
        self.assertEqual({d["name"] for d in index["districts"]},
                         {d["nameLatin"] for d in index["districts"]})

    def test_a_corrupt_meta_json_is_reported_not_a_traceback(self):
        src = self.copy_fixture()
        write(os.path.join(src, bc.META_FILE), '{"schemaVersion": 1, "fetch')
        out, status, err = self.build(src)
        self.assertEqual(status, 1)
        self.assertIn("meta.json in", err)
        self.assertIn("is not valid JSON; delete or regenerate it", err)
        self.assertNotIn("Traceback", err)


class PartialBuilds(Tmp):
    def test_a_districts_build_merges_into_the_existing_catalogue(self):
        legacy_out = os.path.join(self.tmp, "out", "catalogue.json")
        out, status, err = self.build(extra=("--legacy-out", legacy_out))
        self.assertEqual(status, 0, err)
        before = read_tree(os.path.dirname(out))
        src = self.copy_fixture()
        self.add_panchayats(src, [("9001", "Zeta", [["अजमा", "1", "", ""]])])
        status, err = run(["--input", src, "--out", out, "--districts", "7", "--legacy-out", legacy_out])
        self.assertEqual(status, 0, err)
        after = read_tree(os.path.dirname(out))
        self.assertEqual(sorted(after), sorted(before))
        for name in ("catalogue/bharatpur.json", "catalogue/bikaner.json",
                     "catalogue/jodhpur.json", "catalogue/udaipur.json"):
            self.assertEqual(after[name], before[name], name)
        index = load(os.path.join(out, "index.json"))
        self.assertEqual(len(index["districts"]), 5)
        bhilwara = next(d for d in index["districts"] if d["id"] == "7")
        self.assertEqual((bhilwara["file"], bhilwara["panchayatCount"]), ("bhilwara.json", 2))
        self.assertEqual(index["summary"]["districtsBuilt"], ["7"])
        legacy = load(out + ".json")
        self.assertEqual([d["id"] for d in legacy["districts"]], ["6", "7", "8", "22", "33"])

    def test_a_districts_filter_that_matches_nothing_fails_and_deletes_nothing(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        before = read_tree(os.path.dirname(out))
        status, err = run(["--input", FIXTURE, "--out", out, "--districts", "999"])
        self.assertEqual(status, 1)
        self.assertIn("--districts 999: no such district in page.html", err)
        self.assertEqual(read_tree(os.path.dirname(out)), before)

    def test_an_unreadable_earlier_index_does_not_crash_the_build(self):
        out = os.path.join(self.tmp, "out", "catalogue")
        os.makedirs(out)
        for text in ("[]", '{"schemaVersion": 1, "districts": [1, 2]}', "not json"):
            write(os.path.join(out, "index.json"), text)
            write(os.path.join(out, "keep.json"), "{}")
            status, err = run(["--input", FIXTURE, "--out", out])
            self.assertEqual(status, 0, err)
            self.assertEqual(len(load(os.path.join(out, "index.json"))["districts"]), 5)
            self.assertTrue(os.path.exists(os.path.join(out, "keep.json")))

    def test_a_full_build_removes_shards_the_earlier_index_listed_and_no_longer_writes(self):
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        index = load(os.path.join(out, "index.json"))
        index["districts"].append({"id": "99", "file": "gone.json"})
        write(os.path.join(out, "index.json"), json.dumps(index))
        write(os.path.join(out, "gone.json"), "{}")
        out, status, err = self.build()
        self.assertEqual(status, 0, err)
        self.assertFalse(os.path.exists(os.path.join(out, "gone.json")))


class BuildFailures(Tmp):
    ALMAS = bc.search_file("7", "60", "2610")
    WHERE = "district BHILWARA (7) / panchayat Almas (2610)"

    def edit_almas(self, edit):
        src = self.copy_fixture()
        path = os.path.join(src, self.ALMAS)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        new = edit(text)
        self.assertNotEqual(new, text)
        write(path, new)
        return src

    def assert_fails(self, src, reason, where=WHERE):
        out, status, err = self.build(src)
        self.assertNotEqual(status, 0)
        self.assertIn(where, err)
        self.assertRegex(err, reason)
        self.assertNotIn("Traceback", err)
        self.assertFalse(os.path.exists(out))
        self.assertFalse(os.path.exists(out + ".json"))

    @staticmethod
    def rows(text):
        return re.findall(r"<tr><td>.*?</tr>", text)

    def test_a_panchayat_with_zero_wards_fails(self):
        src = self.edit_almas(lambda t: re.sub(r"<tr><td>.*?</tr>\n?", "", t))
        self.assert_fails(src, "zero wards")

    def test_a_search_response_without_a_ward_grid_fails_as_such(self):
        src = self.edit_almas(lambda t: re.sub(r"<table.*</table>", "<p>Error</p>", t, flags=re.S))
        self.assert_fails(src, re.escape(f"no ward grid in {self.ALMAS}"))

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

    def test_a_ward_number_that_is_not_a_number_fails(self):
        def letters(text):
            row = self.rows(text)[1]
            return text.replace(row, row.replace("<td>2</td>", "<td>2A</td>"))
        self.assert_fails(self.edit_almas(letters), "ward number '2A' is not a number")

    def test_grampanchayat_cells_that_disagree_fail(self):
        def other(text):
            row = self.rows(text)[4]
            return text.replace(row, row.replace("आलमास", "अरौदा"))
        self.assert_fails(self.edit_almas(other), "Grampanchayat cells .* disagree")

    def test_a_missing_district_response_fails(self):
        src = self.copy_fixture()
        os.remove(os.path.join(src, bc.district_file("7")))
        self.assert_fails(src, "no saved response district-7.html", "district BHILWARA (7)")

    def test_a_missing_samiti_response_fails(self):
        src = self.copy_fixture()
        os.remove(os.path.join(src, bc.samiti_file("7", "60")))
        self.assert_fails(src, "no saved response samiti-7-60.html",
                          "district BHILWARA (7) / samiti MANDAL PANCHAYAT SAMITI (60)")

    def test_a_missing_page_fails(self):
        src = self.copy_fixture()
        os.remove(os.path.join(src, bc.PAGE_FILE))
        self.assert_fails(src, "no saved response page.html", src)


class FakePortal:
    """Stands in for PoliteClient: answers the roll page's GET and posts and
    the PDF host's GETs from a directory of saved responses."""

    def __init__(self, saved_dir, stop_after=None, cover_status=200):
        self.saved = saved_dir
        self.counts = {}
        self.searches = []
        self.covers = []
        self.stop_after = stop_after
        self.cover_status = cover_status

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
            self.covers.append(url)
            if self.cover_status in (403, 429):  # what PoliteClient does with these
                raise bc.Blocked(f"GET {url} answered {self.cover_status}")
            if self.cover_status == 200:
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
        self.assertIn("about 0 left", err.splitlines()[-1])
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

    def test_a_samiti_with_no_cover_is_recorded_once_and_builds_with_latin_names(self):
        raw = os.path.join(self.tmp, "raw")
        first = FakePortal(FIXTURE, cover_status=302)
        status, err = self.fetch(raw, first)
        self.assertEqual(status, 0, err)
        self.assertEqual(len(first.covers), 5)
        self.assertIn("about 0 left", err.splitlines()[-1])
        marker = load(os.path.join(raw, bc.cover_missing_file("60")))
        self.assertEqual(marker["schemaVersion"], bc.SCHEMA_VERSION)
        self.assertEqual(marker["tried"][0]["status"], 302)
        again = FakePortal(FIXTURE, cover_status=302)
        self.assertEqual(self.fetch(raw, again)[0], 0)
        self.assertEqual(again.counts, {})
        out, status, err = self.build(raw)
        self.assertEqual(status, 0, err)
        index = load(os.path.join(out, "index.json"))
        self.assertEqual(len(index["summary"]["fallbacks"]), 10)
        self.assertIn("the portal gave no cover PDF (cover-60.missing.json)", err)

    def test_a_refused_cover_stops_the_run_and_keeps_what_was_saved(self):
        raw = os.path.realpath(os.path.join(self.tmp, "raw"))
        portal = FakePortal(FIXTURE, cover_status=403)
        with mock.patch.object(bc, "PoliteClient", lambda **kw: portal):
            status, err = run(["--fetch", raw, "--out", os.path.join(self.tmp, "o", "catalogue")])
        self.assertEqual(status, 2)
        self.assertIn("STOPPED: GET", err)
        self.assertIn("answered 403", err)
        self.assertEqual(len(portal.covers), 1)
        saved = os.listdir(raw)
        self.assertIn(bc.search_file("6", "50", "2240"), saved)
        self.assertNotIn(bc.cover_file("50"), saved)
        self.assertNotIn(bc.cover_missing_file("50"), saved)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "o")))

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
