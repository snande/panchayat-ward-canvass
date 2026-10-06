import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import check_pwa_shell

REPO = check_pwa_shell.ROOT
HARNESS = Path(__file__).resolve().parent / "sw_behavior_test.js"
SHELL_ITEMS = ("index.html", "manifest.webmanifest", "sw.js", "css", "js", "icons")
NODE = shutil.which("node")


class PwaShellTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for item in SHELL_ITEMS:
            src = REPO / item
            if src.is_dir():
                shutil.copytree(src, self.root / item)
            else:
                shutil.copy(src, self.root / item)

    def edit(self, name, fn):
        path = self.root / name
        path.write_text(fn(path.read_text(encoding="utf-8")), encoding="utf-8")

    def edit_manifest(self, fn):
        path = self.root / "manifest.webmanifest"
        data = json.loads(path.read_text(encoding="utf-8"))
        fn(data)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def assertError(self, fragment):
        errors = check_pwa_shell.check(self.root)
        self.assertTrue(any(fragment in e for e in errors), (fragment, errors))

    def test_real_shell_meets_acceptance_criteria(self):
        self.assertEqual(check_pwa_shell.check(), [])

    def test_fixture_copy_passes(self):
        self.assertEqual(check_pwa_shell.check(self.root), [])

    def test_wrong_icon_size_is_caught(self):
        self.edit_manifest(lambda m: m["icons"][0].update(sizes="144x144"))
        self.assertError("declares 144x144")
        self.assertError("lacks a 192x192")

    def test_missing_maskable_is_caught(self):
        self.edit_manifest(lambda m: [i.update(purpose="any") for i in m["icons"]])
        self.assertError("maskable")

    def test_non_devanagari_name_is_caught(self):
        self.edit_manifest(lambda m: m.update(name="Ward Canvass"))
        self.assertError("Devanagari")

    def test_precache_missing_asset_is_caught(self):
        self.edit("sw.js", lambda s: s.replace('  "js/app.js",\n', ""))
        self.assertError("PRECACHE lacks js/app.js")

    def test_dotted_precache_entry_is_not_mangled(self):
        self.edit("sw.js", lambda s: s.replace('  "js/app.js",\n', '  "js/app.js",\n  ".hidden/x.js",\n'))
        self.assertError("PRECACHE entry .hidden/x.js does not exist")

    def test_parse_precache_handles_brackets_comments_and_slashes(self):
        text = 'const PRECACHE = [\n  "a.js", // trailing ] comment\n  "b[1].js",\n  /* ] */ "c//d.js",\n];\nconst X = ["z"];'
        self.assertEqual(check_pwa_shell.parse_precache(text), ["a.js", "b[1].js", "c//d.js"])

    def test_foreign_origin_is_caught(self):
        self.edit("index.html", lambda s: s.replace(
            "</head>", '<link rel="stylesheet" href="https://fonts.example.com/x.css"></head>'))
        self.assertError("foreign origin https://fonts.example.com")

    def test_protocol_relative_origin_is_caught(self):
        self.edit("css/app.css", lambda s: s + '@import url("//cdn.example.com/x.css");\n')
        self.assertError("foreign origin //cdn.example.com")

    def test_oversize_precache_is_caught(self):
        with open(self.root / "css" / "app.css", "a", encoding="utf-8") as fh:
            fh.write("/*" + "x" * (400 * 1024) + "*/\n")
        self.assertError("precached assets total")

    def test_missing_activate_cleanup_is_caught(self):
        self.edit("sw.js", lambda s: s.replace("caches.delete", "caches.noop"))
        self.assertError("delete old caches")

    def test_unregistered_service_worker_is_caught(self):
        self.edit("js/app.js", lambda s: s.replace(".register(", ".registerX("))
        self.assertError("register sw.js")

    def test_wrong_html_lang_is_caught(self):
        self.edit("index.html", lambda s: s.replace('lang="hi"', 'lang="en"'))
        self.assertError('<html lang="hi">')

    @unittest.skipUnless(NODE, "node not installed")
    def test_js_syntax_error_is_caught(self):
        self.edit("sw.js", lambda s: s + '\nconst BROKEN = "unterminated;\n')
        self.assertError("sw.js does not parse")


@unittest.skipUnless(NODE, "node not installed")
class ServiceWorkerBehaviourTest(unittest.TestCase):
    """Runs sw.js in a stubbed worker sandbox (scripts/sw_behavior_test.js)."""

    def run_harness(self, sw_path):
        return subprocess.run([NODE, str(HARNESS), str(sw_path)], capture_output=True, text=True)

    def test_sw_installs_activates_and_serves_offline(self):
        proc = self.run_harness(REPO / "sw.js")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("ok - offline navigation renders the cached shell", proc.stdout)

    def mutated(self, old, new):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        text = (REPO / "sw.js").read_text(encoding="utf-8")
        self.assertIn(old, text)
        path = Path(tmp.name) / "sw.js"
        path.write_text(text.replace(old, new), encoding="utf-8")
        return self.run_harness(path)

    def test_harness_catches_missing_old_cache_cleanup(self):
        proc = self.mutated("return caches.delete(key);", "return key;")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not ok - activate deletes older versioned caches only", proc.stdout)

    def test_harness_catches_missing_offline_fallback(self):
        proc = self.mutated(".catch(cachedShell)", ".catch(function (e) { throw e; })")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not ok - offline navigation renders the cached shell", proc.stdout)

    def test_harness_catches_incomplete_precache(self):
        proc = self.mutated('  "css/app.css",\n', "")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not ok - install precaches", proc.stdout)


if __name__ == "__main__":
    unittest.main()
