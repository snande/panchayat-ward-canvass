"""The catalogue generator's build stage (issue #121):

    python3 tools/sec-catalogue/build_catalogue.py --input DIR --out DIR

It is run over fixtures/sec/portal-responses, and over copies of it with a
Search response broken or extra panchayats added.

    cd scripts && python3 -m unittest test_build_catalogue
"""

import contextlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
TOOL = REPO / "tools" / "sec-catalogue"
SCRIPT = TOOL / "build_catalogue.py"
FIXTURE = REPO / "fixtures" / "sec" / "portal-responses"
COMMITTED = REPO / "data" / "sec" / "catalogue"
MANIFEST = REPO / "fixtures" / "sec" / "manifest.json"

sys.path.insert(0, str(TOOL))
import build_catalogue  # noqa: E402 - the tool directory is put on the path above

ALMAS = "search-7-60-2610.html"
WHERE = ("BHILWARA (7)", "Almas (2610)")
GRID_ROW_RE = re.compile(r"\t<tr><td>.*?</tr>\n")


def run(input_dir, out_dir):
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    return subprocess.run([sys.executable, str(SCRIPT), "--input", str(input_dir),
                           "--out", str(out_dir)],
                          capture_output=True, text=True, encoding="utf-8", env=env)


def summary(result):
    return json.loads(result.stdout.strip().splitlines()[-1])["summary"]


def snapshot(directory):
    """Every file under directory, by name, as bytes."""
    directory = Path(directory)
    if not directory.exists():
        return {}
    return {p.name: p.read_bytes() for p in sorted(directory.iterdir())}


def load(directory, name):
    return json.loads((Path(directory) / name).read_text(encoding="utf-8"))


class BuildTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.input = self.tmp / "input"
        shutil.copytree(FIXTURE, self.input)
        self.out = self.tmp / "out"

    def edit(self, name, fn):
        path = self.input / name
        path.write_text(fn(path.read_text(encoding="utf-8")), encoding="utf-8")

    def edit_grid(self, fn):
        """Rewrite the Almas grid's ward rows: fn gets and returns the list."""
        def change(html):
            rows = GRID_ROW_RE.findall(html)
            self.assertEqual(len(rows), 9)
            start = html.index(rows[0])
            end = html.index(rows[-1]) + len(rows[-1])
            return html[:start] + "".join(fn(rows)) + html[end:]
        self.edit(ALMAS, change)

    def add_panchayat(self, gp, hindi, wards, name=None):
        """A Search response for another panchayat of Mandal samiti (60),
        built from Almas's, listing the given ward numbers in that order."""
        html = (self.input / ALMAS).read_text(encoding="utf-8")
        html = html.replace('<option selected="selected" value="2610">', '<option value="2610">')
        html = re.sub(rf'<option value="{gp}">', f'<option selected="selected" value="{gp}">', html)
        rows = GRID_ROW_RE.findall(html)
        new_rows = [rows[0].replace("<td>आलमास</td>", f"<td>{hindi}</td>")
                           .replace("<td>1</td>", f"<td>{w}</td>") for w in wards]
        start = html.index(rows[0])
        end = html.index(rows[-1]) + len(rows[-1])
        (self.input / f"search-7-60-{gp}.html").write_text(
            html[:start] + "".join(new_rows) + html[end:], encoding="utf-8")

    def assert_fails_on_almas(self, result, reason):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        for part in WHERE:
            self.assertIn(part, result.stderr)
        self.assertIn(reason, result.stderr)
        self.assertEqual(snapshot(self.out), {}, "a failed run must write nothing")

    # --- output shape -------------------------------------------------------

    def test_index_and_district_files_carry_schema_version_and_fields(self):
        result = run(self.input, self.out)
        self.assertEqual(result.returncode, 0, result.stderr)
        index = load(self.out, "index.json")
        self.assertIsInstance(index["schemaVersion"], int)
        self.assertEqual([d["id"] for d in index["districts"]], ["6", "7"])
        files = {"index.json"}
        for district in index["districts"]:
            self.assertEqual(set(district) & {"id", "name", "file", "panchayatCount"},
                             {"id", "name", "file", "panchayatCount"})
            files.add(district["file"])
            shard = load(self.out, district["file"])
            self.assertIsInstance(shard["schemaVersion"], int)
            self.assertEqual(len(shard["panchayats"]), district["panchayatCount"])
            for p in shard["panchayats"]:
                for key in ("id", "name", "block", "wards"):
                    self.assertIn(key, p)
                self.assertRegex(p["name"], r"^[ऀ-ॿ]+$", "name is the Hindi grid name")
                self.assertTrue(p["block"].endswith("PANCHAYAT SAMITI"))
                self.assertGreater(len(p["wards"]), 0)
                for w in p["wards"]:
                    self.assertIsInstance(w["ward"], int)
                    self.assertTrue(w["pdfUrl"].startswith("https://"))
        self.assertEqual(set(snapshot(self.out)), files, "every file written is indexed")

    def test_every_written_file_carries_schema_version(self):
        self.assertEqual(run(self.input, self.out).returncode, 0)
        for name, raw in snapshot(self.out).items():
            self.assertIn("schemaVersion", json.loads(raw.decode("utf-8")), name)

    def test_committed_catalogue_is_what_the_build_writes(self):
        self.assertEqual(run(FIXTURE, self.out).returncode, 0)
        self.assertEqual(snapshot(self.out), snapshot(COMMITTED))

    def test_two_runs_write_identical_bytes(self):
        self.assertEqual(run(self.input, self.out).returncode, 0)
        again = self.tmp / "again"
        self.assertEqual(run(self.input, again).returncode, 0)
        self.assertEqual(snapshot(self.out), snapshot(again))

    def test_pdf_urls_match_the_urls_the_portal_resolved(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        for entry in manifest["panchayats"]:
            template = entry["pdf_columns"]["Final PDF"]["url_template"]
            for ward in range(1, entry["ward_count"] + 1):
                self.assertEqual(
                    build_catalogue.ward_pdf_url(entry["samiti"]["id"], entry["panchayat"]["name"],
                                                 ward),
                    template.replace("{NNN}", f"{ward:03d}"))
        self.assertEqual(run(self.input, self.out).returncode, 0)
        shard = load(self.out, "bhilwara.json")
        almas = next(e for e in manifest["panchayats"] if e["panchayat"]["id"] == "2610")
        self.assertEqual(shard["panchayats"][0]["wards"][0]["pdfUrl"],
                         almas["pdf_columns"]["Final PDF"]["ward_1_link_resolved_to"])

    # --- urban bodies ---------------------------------------------------------

    def test_urban_wards_are_skipped_and_counted_in_the_stdout_summary(self):
        result = run(self.input, self.out)
        self.assertEqual(result.returncode, 0, result.stderr)
        counts = summary(result)
        self.assertEqual(counts["urbanBodiesSkipped"], 1)
        self.assertEqual(counts["urbanWardsSkipped"], 35)
        for name, raw in snapshot(self.out).items():
            text = raw.decode("utf-8")
            self.assertNotIn("CHAKSU", text, name)
            self.assertNotIn("11473", text, name)
            self.assertNotIn("वार्ड क्र.", text, name)
        self.assertNotIn("JAIPUR", [d["name"] for d in load(self.out, "index.json")["districts"]])

    # --- sorting ----------------------------------------------------------------

    def test_panchayats_sort_by_hindi_name_and_wards_by_number(self):
        # Hindi order (अ < आ < ब) differs from both id order and Latin order.
        self.add_panchayat("2611", "अमरगढ़", [3, 1, 2])
        self.add_panchayat("2612", "बागोर", [2, 10, 1])
        self.edit_grid(lambda rows: rows[::-1])
        result = run(self.input, self.out)
        self.assertEqual(result.returncode, 0, result.stderr)
        panchayats = load(self.out, "bhilwara.json")["panchayats"]
        self.assertEqual([p["name"] for p in panchayats], ["अमरगढ़", "आलमास", "बागोर"])
        self.assertEqual([p["id"] for p in panchayats], ["2611", "2610", "2612"])
        self.assertEqual([w["ward"] for w in panchayats[0]["wards"]], [1, 2, 3])
        self.assertEqual([w["ward"] for w in panchayats[1]["wards"]], list(range(1, 10)))
        self.assertEqual([w["ward"] for w in panchayats[2]["wards"]], [1, 2, 10])
        self.assertTrue(panchayats[2]["wards"][2]["pdfUrl"].endswith("/BAGOR-Ward%20No-010.pdf"))
        self.assertEqual(load(self.out, "index.json")["districts"][1]["panchayatCount"], 3)

    # --- failures ---------------------------------------------------------------

    def test_zero_wards_fails_naming_district_and_panchayat(self):
        self.edit_grid(lambda rows: [])
        self.assert_fails_on_almas(run(self.input, self.out), "zero wards")

    def test_missing_pdf_link_fails_naming_district_and_panchayat(self):
        def drop_link(rows):
            rows[2] = re.sub(r"<a [^>]*FinalPdf[^>]*>.*?</a>", "", rows[2], count=1)
            return rows
        self.edit_grid(drop_link)
        self.assert_fails_on_almas(run(self.input, self.out), "ward 3 has no pdfUrl")

    def test_repeated_ward_fails_naming_district_and_panchayat(self):
        def repeat(rows):
            rows[4] = rows[4].replace("<td>5</td>", "<td>4</td>")
            return rows
        self.edit_grid(repeat)
        self.assert_fails_on_almas(run(self.input, self.out), "ward 4 repeats")

    def test_missing_grid_header_fails_naming_district_and_panchayat(self):
        self.edit(ALMAS, lambda html: html.replace("<th scope=\"col\">Ward No.</th>",
                                                   "<th scope=\"col\">Ward</th>"))
        self.assert_fails_on_almas(run(self.input, self.out), "no ward grid")

    def test_malformed_grid_row_fails_naming_district_and_panchayat(self):
        def short_row(rows):
            rows[6] = re.sub(r"<td><a [^>]*SuppPdf.*?</td>", "", rows[6], count=1)
            return rows
        self.edit_grid(short_row)
        self.assert_fails_on_almas(run(self.input, self.out), "grid row has 3 cells")

    def test_missing_hindi_name_fails_instead_of_falling_back_to_latin(self):
        self.edit(ALMAS, lambda html: html.replace("<td>आलमास</td>", "<td></td>"))
        self.assert_fails_on_almas(run(self.input, self.out), "cell is empty")

    def test_failed_run_leaves_existing_output_untouched(self):
        self.assertEqual(run(self.input, self.out).returncode, 0)
        before = snapshot(self.out)
        self.edit_grid(lambda rows: rows + [rows[0]])
        result = run(self.input, self.out)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ward 1 repeats", result.stderr)
        self.assertEqual(snapshot(self.out), before)
        self.assertEqual([p.name for p in self.tmp.iterdir() if p.name.startswith(".")], [],
                         "no staging directory is left behind")

    # --- names whose PDF file name is not confirmed --------------------------------

    def test_unconfirmed_name_without_a_saved_click_fails(self):
        self.add_panchayat("2624", "दांता (लुहाडिया)", [1, 2])
        result = run(self.input, self.out)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BHILWARA (7)", result.stderr)
        self.assertIn("Danta (Luhadiya) (2624)", result.stderr)
        self.assertIn("no saved Final PDF click", result.stderr)
        self.assertEqual(snapshot(self.out), {})

    def test_unconfirmed_name_takes_the_pdf_file_name_from_the_saved_click(self):
        self.add_panchayat("2624", "दांता (लुहाडिया)", [1, 2])
        url = ("https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/60/"
               "DANTA(LUHADIYA)-Ward No-001.pdf")
        body = f"<html><script>window.open('{url}','_newtab');</script></html>".encode("utf-8")
        (self.input / "click-7-60-2624.html").write_bytes(
            build_catalogue.click_record(200, {"Content-Type": "text/html"}, body))
        result = run(self.input, self.out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary(result)["pdfUrlsFromClicks"], 1)
        danta = next(p for p in load(self.out, "bhilwara.json")["panchayats"] if p["id"] == "2624")
        self.assertEqual([w["pdfUrl"] for w in danta["wards"]], [
            "https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/60/"
            f"DANTA(LUHADIYA)-Ward%20No-{n:03d}.pdf" for n in (1, 2)])

    def test_click_answered_by_a_redirect(self):
        record = build_catalogue.click_record(
            302, {"Location": "https://esuchiroll.rajasthan.gov.in/x/A B-Ward No-001.pdf"}, b"")
        self.assertEqual(build_catalogue.pdf_location(record),
                         "https://esuchiroll.rajasthan.gov.in/x/A%20B-Ward%20No-001.pdf")
        self.assertIsNone(build_catalogue.pdf_location(
            build_catalogue.click_record(200, {}, b"<html>no link</html>")))

    # --- no network, pruning ------------------------------------------------------

    def test_input_mode_makes_no_network_request(self):
        def refuse(*_args, **_kwargs):
            raise AssertionError("network access in --input mode")
        stdout = io.StringIO()
        with mock.patch.object(socket.socket, "connect", refuse), \
                mock.patch.object(socket, "create_connection", refuse), \
                mock.patch.object(urllib.request, "urlopen", refuse), \
                mock.patch.object(urllib.request.OpenerDirector, "open", refuse), \
                mock.patch.object(build_catalogue.PoliteClient, "request", refuse), \
                contextlib.redirect_stdout(stdout):
            code = build_catalogue.main(["--input", str(self.input), "--out", str(self.out)])
        self.assertEqual(code, 0)
        self.assertEqual(snapshot(self.out), snapshot(COMMITTED))

    def test_input_mode_does_not_write_the_single_file_catalogue(self):
        legacy = REPO / "data" / "sec" / "catalogue.json"
        before = legacy.read_bytes()
        self.assertEqual(run(self.input, self.out).returncode, 0)
        self.assertEqual(legacy.read_bytes(), before)

    def test_districts_dropped_from_the_input_are_pruned(self):
        self.assertEqual(run(self.input, self.out).returncode, 0)
        (self.input / "search-6-50-2240.html").unlink()
        self.assertEqual(run(self.input, self.out).returncode, 0)
        self.assertEqual(set(snapshot(self.out)), {"index.json", "bhilwara.json"})

    def test_a_narrowed_run_does_not_prune(self):
        self.assertEqual(run(self.input, self.out).returncode, 0)
        build_catalogue.write_shards(self.out, [], prune=False)
        self.assertEqual(set(snapshot(self.out)), {"index.json", "bharatpur.json", "bhilwara.json"})
        self.assertEqual(load(self.out, "index.json")["districts"], [])

    def test_a_write_error_leaves_the_previous_output_in_place(self):
        self.assertEqual(run(self.input, self.out).returncode, 0)
        before = snapshot(self.out)
        real = build_catalogue.write_json
        calls = []

        def fail_second(path, obj):
            calls.append(path)
            if len(calls) == 2:
                raise OSError("disk full")
            real(path, obj)
        districts = [{"id": "6", "name": "BHARATPUR", "panchayats": []},
                     {"id": "7", "name": "BHILWARA", "panchayats": []}]
        with mock.patch.object(build_catalogue, "write_json", fail_second):
            with self.assertRaises(OSError):
                build_catalogue.write_shards(self.out, districts, prune=True)
        self.assertEqual(snapshot(self.out), before)
        self.assertEqual([p.name for p in self.tmp.iterdir() if p.name.startswith(".")], [])


if __name__ == "__main__":
    unittest.main()
