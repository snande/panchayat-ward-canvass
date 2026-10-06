import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import check_pwa_shell

REPO = check_pwa_shell.ROOT
HARNESS = Path(__file__).resolve().parent / "sw_behavior_test.cjs"
SHELL_ITEMS = ("index.html", "manifest.webmanifest", "sw.js", "styles.css", "js", "icons", "src", "fonts")
FONT = "fonts/noto-sans-devanagari-subset.woff2"
NODE = shutil.which("node")


class PwaShellTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for item in SHELL_ITEMS:
            src = REPO / item
            if not src.exists():
                continue
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
        self.edit("styles.css", lambda s: s + '@import url("//cdn.example.com/x.css");\n')
        self.assertError("foreign origin //cdn.example.com")

    def test_oversize_precache_is_caught(self):
        with open(self.root / "styles.css", "a", encoding="utf-8") as fh:
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

    def write_font(self, data):
        path = self.root / FONT
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def append_css(self, text):
        with open(self.root / "styles.css", "a", encoding="utf-8") as fh:
            fh.write(text)

    def edit_strings(self, fn):
        path = self.root / "src" / "strings.hi.json"
        table = json.loads(path.read_text(encoding="utf-8"))
        fn(table)
        path.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")

    def test_fixture_with_valid_font_header_passes(self):
        # Every check except the real font's presence: a WOFF2 header stands in.
        self.write_font(b"wOF2" + b"\0" * 1024)
        self.assertEqual(check_pwa_shell.check(self.root), [])

    def test_font_missing_from_precache_is_caught(self):
        self.edit("sw.js", lambda s: s.replace('  "%s",\n' % FONT, ""))
        self.assertError("PRECACHE lacks " + FONT)

    def test_strings_missing_from_precache_is_caught(self):
        self.edit("sw.js", lambda s: s.replace('  "src/strings.hi.json",\n', ""))
        self.assertError("PRECACHE lacks src/strings.hi.json")

    def test_font_display_other_than_swap_is_caught(self):
        self.edit("styles.css", lambda s: s.replace("font-display: swap", "font-display: block"))
        self.assertError("font-display: swap")

    def test_remote_font_face_is_caught(self):
        self.edit("styles.css", lambda s: s.replace(FONT, "https://fonts.example.com/devanagari.woff2"))
        self.assertError("must be a relative fonts/ path")
        self.assertError("foreign origin https://fonts.example.com")

    def test_preload_must_match_font_face_url(self):
        self.edit("index.html", lambda s: s.replace(
            'href="%s" as="font"' % FONT, 'href="fonts/other.woff2" as="font"'))
        self.assertError("preloads fonts/other.woff2, which no @font-face loads")

    def test_missing_font_file_is_caught(self):
        (self.root / FONT).unlink(missing_ok=True)
        self.assertError("font %s missing" % FONT)

    def test_non_woff2_font_is_caught(self):
        self.write_font(b"\0\1\0\0 a TrueType file")
        self.assertError("is not a WOFF2 file")

    def test_oversize_font_is_caught(self):
        self.write_font(b"wOF2" + b"\0" * (400 * 1024))
        self.assertError("precached assets total")

    def test_hard_coded_colour_in_components_is_caught(self):
        self.append_css(".btn-primary:hover { background: #ff0000; }\nheader { color: white; }\n")
        self.assertError(".btn-primary:hover hard-codes a colour")
        self.assertError("header hard-codes a colour")

    def test_hard_coded_colour_in_empty_state_is_caught(self):
        self.append_css(".empty-state p { color: rgb(1, 2, 3); }\n")
        self.assertError(".empty-state p hard-codes a colour")

    def test_theme_colour_must_match_token(self):
        self.edit("index.html", lambda s: s.replace('content="#0f766e"', 'content="#e65100"'))
        self.edit_manifest(lambda m: m.update(background_color="#ffffff"))
        self.assertError("index.html theme-color must equal the --color-primary token")
        self.assertError("manifest background_color must equal the --color-bg token")

    def test_missing_token_family_is_caught(self):
        self.edit("styles.css", lambda s: s.replace("--radius-", "--corner-"))
        self.assertError(":root lacks --radius-")

    def test_small_type_token_is_caught(self):
        self.edit("styles.css", lambda s: s.replace("--font-size-sm: 1rem", "--font-size-sm: 0.8rem"))
        self.assertError("--font-size-sm must be a px/rem size of at least 16px")

    def test_small_touch_target_is_caught(self):
        self.edit("styles.css", lambda s: s.replace("--touch-target: 48px", "--touch-target: 40px"))
        self.assertError(".btn-primary needs a min-height")

    def test_unresolvable_button_height_is_flagged(self):
        self.edit("styles.css", lambda s: s.replace("--touch-target: 48px", "--touch-target: calc(2em + 16px)"))
        self.assertError("min-height: var(--touch-target) must resolve to px or rem")

    def test_fixed_width_wider_than_phone_is_caught(self):
        self.append_css("main { min-width: 420px; }\n")
        self.assertError("wider than a 360px screen")

    def test_unresolvable_width_is_flagged(self):
        self.append_css(".empty-state { width: calc(400px); }\n.status { width: 30em; }\n")
        self.assertError("width: calc(400px) cannot be checked")
        self.assertError("width: 30em cannot be checked")

    def test_percentage_and_auto_widths_pass(self):
        self.write_font(b"wOF2")
        self.append_css(".status { width: 100%; min-width: auto; }\n")
        self.assertEqual(check_pwa_shell.check(self.root), [])

    def test_english_string_is_caught(self):
        self.edit_strings(lambda t: t.update(primary_action="Load ward list"))
        self.assertError("primary_action must be Hindi")

    def test_unknown_html_key_is_caught(self):
        self.edit("index.html", lambda s: s.replace('data-i18n="empty_body"', 'data-i18n="no_such_key"'))
        self.assertError("string key no_such_key is not in")

    def test_unknown_js_key_is_caught(self):
        self.edit("js/app.js", lambda s: s.replace('setStatus("action_pending")', 'setStatus("action_waiting")'))
        self.assertError("js/app.js uses string key action_waiting")

    def test_html_fallback_drift_is_caught(self):
        self.edit_strings(lambda t: t.update(primary_action="सूची लोड करें"))
        self.assertError("data-i18n=primary_action text")

    def test_inline_english_text_is_caught(self):
        self.edit("index.html", lambda s: s.replace(
            '<p id="status" class="status" aria-live="polite"></p>', "<p>Welcome</p>"))
        self.assertError("inline text 'Welcome'")

    def test_english_aria_label_is_caught(self):
        self.edit("index.html", lambda s: s.replace(
            'class="btn-primary"', 'class="btn-primary" aria-label="Load"'))
        self.assertError("aria-label='Load' is English")

    def test_title_must_come_from_table(self):
        self.edit("index.html", lambda s: s.replace(
            '<title data-i18n="app_title">पंचायत वार्ड कैनवास</title>', "<title>पंचायत</title>"))
        self.assertError("<title> must be")

    def test_manifest_name_must_match_table(self):
        self.edit_manifest(lambda m: m.update(short_name="कैनवास"))
        self.assertError("manifest short_name must equal")

    def test_offline_page_text_must_match_table(self):
        self.edit_strings(lambda t: t.update(offline_body="नेटवर्क नहीं है।"))
        self.assertError("sw.js offline_body differs")

    def test_unlisted_hindi_literal_in_js_is_caught(self):
        self.edit("js/app.js", lambda s: s + '\nsetStatus("तैयार");\n')
        self.assertError("js/app.js has Hindi text 'तैयार'")

    @unittest.skipUnless(NODE, "node not installed")
    def test_js_syntax_error_is_caught(self):
        self.edit("sw.js", lambda s: s + '\nconst BROKEN = "unterminated;\n')
        self.assertError("sw.js does not parse")


@unittest.skipUnless(NODE, "node not installed")
class ServiceWorkerBehaviourTest(unittest.TestCase):
    """Runs sw.js in a stubbed worker sandbox (scripts/sw_behavior_test.cjs)."""

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
        proc = self.mutated('  "styles.css",\n', "")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not ok - install precaches", proc.stdout)


if __name__ == "__main__":
    unittest.main()
