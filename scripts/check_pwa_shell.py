#!/usr/bin/env python3
"""Repo-ci checks for the installable PWA shell (stdlib only).

Run from anywhere: ``python3 scripts/check_pwa_shell.py``. Exits non-zero and
prints one line per problem when the shell breaks an acceptance criterion.
When ``node`` is on PATH the shell's JavaScript is also syntax-checked.
"""
import json
import posixpath
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_PRECACHE_BYTES = 400 * 1024
DEVANAGARI = re.compile("[ऀ-ॿ]")
LATIN_LETTER = re.compile(r"[A-Za-z]")
STRINGS_REL = "src/strings.hi.json"
# Components that must take every colour from the :root design tokens.
TOKEN_COMPONENTS = ("header", ".btn-primary", ".empty-state")
TOKEN_PREFIXES = ("--color-", "--space-", "--radius-", "--font-size-")
COLOUR_LITERAL = re.compile(
    r"#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|"
    r"\b(?:white|black|red|green|blue|orange|yellow|gray|grey|purple|pink|brown|teal|navy)\b",
    re.I,
)
MIN_TOUCH_PX = 48
MIN_FONT_PX = 16
MAX_FIXED_WIDTH_PX = 360
# Width values that can never be wider than the viewport.
SAFE_WIDTH = re.compile(
    r"auto|none|inherit|initial|unset|revert|fit-content|min-content|0|"
    r"(?:100|[1-9]?\d)(?:\.\d+)?(?:%|vw)",
    re.I,
)
# Attributes whose values a user can see or hear.
VISIBLE_ATTRS = ("alt", "title", "placeholder", "aria-label", "value")
# A JS string literal (double, single or template quoted).
JS_STRING = re.compile(r""""((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`""")
# Literal string-key arguments of the shell's lookup helpers.
JS_KEY_CALL = re.compile(r"""\b(setStatus|t)\(\s*["']([A-Za-z0-9_.-]+)["']""")
# Absolute URLs (any host, including localhost and IPs), plus protocol-relative
# URLs that open a string literal, an attribute value or url(...).
URL_RE = re.compile(
    r"""https?://[^\s"'<>)]+|(?<=["'(])//[A-Za-z0-9\[][^\s"'<>)]*""", re.I
)
# Namespace/spec URLs that are identifiers, not network requests.
URL_ALLOWLIST = ("http://www.w3.org/",)
# One JS token inside the PRECACHE array: a string literal, a comment, or the
# closing bracket. Matching strings first means `//` or `]` inside an entry
# cannot be mistaken for a comment or the end of the list.
PRECACHE_TOKEN = re.compile(
    r"""(?P<str>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|//[^\n]*|/\*.*?\*/|(?P<end>\])""",
    re.S,
)


def png_size(path):
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("not a PNG")
    return struct.unpack(">II", data[16:24])


def parse_precache(sw_text):
    """Return the string entries of ``const PRECACHE = [ ... ];`` or None."""
    start = re.search(r"PRECACHE\s*=\s*\[", sw_text)
    if not start:
        return None
    entries = []
    for tok in PRECACHE_TOKEN.finditer(sw_text, start.end()):
        if tok.group("end"):
            break
        if tok.group("str"):
            entries.append(tok.group("str")[1:-1])
    return entries


def precache_files(root, entries):
    files = []
    for entry in entries:
        if entry in ("./", "/", ""):
            name = "index.html"
        else:
            name = posixpath.normpath(entry.removeprefix("./").lstrip("/"))
        path = root / name
        if path not in files:
            files.append(path)
    return files


def js_syntax_errors(root):
    node = shutil.which("node")
    if not node:
        return []
    errors = []
    for rel in ("sw.js", "js/app.js"):
        path = root / rel
        if path.is_file():
            proc = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
            if proc.returncode != 0:
                first = (proc.stderr.strip().splitlines() or ["syntax error"])[0:5]
                errors.append("%s does not parse: %s" % (rel, " | ".join(first)))
    return errors


def css_rules(css):
    """Yield (selector, body) for innermost ``selector { body }`` blocks."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        yield m.group(1).strip(), m.group(2)


def declarations(body):
    for decl in body.split(";"):
        if ":" in decl:
            prop, value = decl.split(":", 1)
            yield prop.strip().lower(), value.strip()


def resolve(value, tokens, depth=0):
    """Substitute a whole-value ``var(--x[, fallback])`` from the :root tokens."""
    value = value.strip()
    m = re.fullmatch(r"var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)", value)
    if not m or depth > 5:
        return value
    if m.group(1) in tokens:
        return resolve(tokens[m.group(1)], tokens, depth + 1)
    return resolve(m.group(2), tokens, depth + 1) if m.group(2) else value


def to_px(value, tokens):
    """Resolve a length to px, or None when it is not a plain px/rem length.

    ``em``, ``calc()`` and the like depend on context the check cannot see, so
    callers must treat None as "cannot verify", never as a pass.
    """
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(px|rem)", resolve(value, tokens))
    if not m:
        return None
    return float(m.group(1)) * (1 if m.group(2) == "px" else 16)


def selector_targets(selector, component):
    return re.search(r"(?:^|[\s>+~,])%s(?![\w-])" % re.escape(component), " " + selector)


def check_css(root, css_path, errors):
    """Check design tokens, component colours, sizes and @font-face rules.

    Returns (tokens, fonts): the :root custom properties and the repo-relative
    font files the stylesheet loads.
    """
    rel = css_path.relative_to(root).as_posix()
    rules = list(css_rules(css_path.read_text(encoding="utf-8")))

    tokens = {}
    for selector, body in rules:
        if selector == ":root":
            tokens.update((p, v) for p, v in declarations(body) if p.startswith("--"))
    for prefix in TOKEN_PREFIXES:
        if not any(name.startswith(prefix) for name in tokens):
            errors.append("%s :root lacks %s* design tokens" % (rel, prefix))
    for name, value in tokens.items():
        if name.startswith("--font-size-"):
            px = to_px(value, tokens)
            if px is None or px < MIN_FONT_PX:
                errors.append("%s %s must be a px/rem size of at least %dpx" % (rel, name, MIN_FONT_PX))

    for component in TOKEN_COMPONENTS:
        matched = [(sel, body) for sel, body in rules if selector_targets(sel, component)]
        if not matched:
            errors.append("%s has no rule for %s" % (rel, component))
        for sel, body in matched:
            for prop, value in declarations(body):
                if not prop.startswith("--") and COLOUR_LITERAL.search(value):
                    errors.append("%s %s hard-codes a colour in %s: %s (use a :root token)"
                                  % (rel, sel, prop, value))

    heights = []
    for sel, body in rules:
        if selector_targets(sel, ".btn-primary"):
            for prop, value in declarations(body):
                if prop in ("min-height", "height"):
                    px = to_px(value, tokens)
                    if px is None:
                        errors.append("%s %s %s: %s must resolve to px or rem"
                                      % (rel, sel, prop, value))
                    else:
                        heights.append(px)
    if not heights or max(heights) < MIN_TOUCH_PX:
        errors.append("%s .btn-primary needs a min-height of at least %dpx" % (rel, MIN_TOUCH_PX))

    body_size = None
    for sel, body in rules:
        if sel == "body":
            for prop, value in declarations(body):
                if prop == "font-size":
                    body_size = to_px(value, tokens)
    if body_size is None or body_size < MIN_FONT_PX:
        errors.append("%s body font-size must be a px/rem size of at least %dpx" % (rel, MIN_FONT_PX))

    for sel, body in rules:
        for prop, value in declarations(body):
            if prop not in ("width", "min-width"):
                continue
            px = to_px(value, tokens)
            if px is not None:
                if px > MAX_FIXED_WIDTH_PX:
                    errors.append("%s %s sets %s: %s, wider than a %dpx screen"
                                  % (rel, sel, prop, value, MAX_FIXED_WIDTH_PX))
            elif not SAFE_WIDTH.fullmatch(resolve(value, tokens)):
                errors.append("%s %s %s: %s cannot be checked against a %dpx screen "
                              "(use px/rem, a percentage or auto)"
                              % (rel, sel, prop, value, MAX_FIXED_WIDTH_PX))

    fonts = []
    faces = [body for sel, body in rules if sel == "@font-face"]
    if not faces:
        errors.append("%s has no @font-face for the self-hosted Devanagari font" % rel)
    for body in faces:
        props = dict(declarations(body))
        if props.get("font-display", "").lower() != "swap":
            errors.append("%s @font-face must use font-display: swap" % rel)
        urls = re.findall(r"url\(\s*[\"']?([^\"')]+)", props.get("src", ""))
        if not urls:
            errors.append("%s @font-face has no url() source" % rel)
        for url in urls:
            if re.match(r"(?:[a-z][a-z0-9+.-]*:|//)", url, re.I):
                errors.append("%s @font-face src %s must be a relative fonts/ path" % (rel, url))
                continue
            font = posixpath.normpath(posixpath.join(posixpath.dirname(rel), url))
            if not (font.startswith("fonts/") and font.endswith(".woff2")):
                errors.append("%s @font-face src %s must be a .woff2 under fonts/" % (rel, url))
                continue
            path = root / font
            if not path.is_file():
                errors.append("font %s missing (run scripts/build_font.sh)" % font)
            elif path.read_bytes()[:4] != b"wOF2":
                errors.append("font %s is not a WOFF2 file" % font)
            fonts.append(font)
    return tokens, fonts


def load_strings(root, errors):
    path = root / STRINGS_REL
    if not path.is_file():
        errors.append("%s missing" % STRINGS_REL)
        return {}
    try:
        table = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        errors.append("%s is not valid JSON: %s" % (STRINGS_REL, exc))
        return {}
    if not isinstance(table, dict) or not all(isinstance(v, str) for v in table.values()):
        errors.append("%s must be a flat object of strings" % STRINGS_REL)
        return {}
    for key, value in table.items():
        if not DEVANAGARI.search(value) or LATIN_LETTER.search(value):
            errors.append("%s %s must be Hindi (Devanagari, no Latin letters)" % (STRINGS_REL, key))
    return table


def check_html_strings(html, table, errors):
    """index.html text must come from the table: data-i18n elements may hold
    only their own table string (as a no-JS fallback) and nothing else may."""
    used = set()
    stripped = html
    for m in re.finditer(
            r"""<(\w+)\b([^>]*\bdata-i18n=["']([^"']+)["'][^>]*)>(.*?)</\1>""", html, re.S):
        key, inner = m.group(3), " ".join(m.group(4).split())
        used.add(key)
        if key not in table:
            errors.append("string key %s is not in %s" % (key, STRINGS_REL))
        elif inner and inner != table[key]:
            errors.append("index.html data-i18n=%s text %r differs from %s"
                          % (key, inner[:40], STRINGS_REL))
        stripped = stripped.replace(m.group(0), "<%s%s></%s>" % (m.group(1), m.group(2), m.group(1)))
    if not used:
        errors.append("index.html takes no text from %s (use data-i18n)" % STRINGS_REL)

    title = re.search(r"<title\b([^>]*)>(.*?)</title>", html, re.S)
    if not title or "app_title" not in title.group(1) or title.group(2).strip() != table.get("app_title"):
        errors.append('index.html <title> must be data-i18n="app_title" with that table string')

    body = re.search(r"<body[^>]*>(.*)</body>", stripped, re.S)
    body = body.group(1) if body else ""
    body = re.sub(r"<!--.*?-->|<(script|style)\b.*?</\1>", "", body, flags=re.S | re.I)
    text = " ".join(re.sub(r"<[^>]*>", " ", body).split())
    if text:
        errors.append("index.html has inline text %r; put it in %s" % (text[:60], STRINGS_REL))
    for attr, value in re.findall(r"""\b(%s)=["']([^"']*)["']""" % "|".join(VISIBLE_ATTRS), body):
        if LATIN_LETTER.search(value):
            errors.append("index.html %s=%r is English, user-visible text" % (attr, value))


def check_js_strings(rel, source, table, errors):
    """Check a shell script's use of the string table.

    - Every key passed literally to ``t()`` or ``setStatus()`` must exist.
    - Every Hindi literal must be a copy of a table string; a copy written as
      ``key: "..."`` with a table key must equal that key's string.
    - Every ``setStatus()`` key needs such a keyed copy, so status lines still
      show Hindi when the table fails to load.

    Limit: keys passed through variables (e.g. the ``data-i18n`` lookup in
    ``applyStrings``) are not traced. Those keys come from index.html and are
    checked there by ``check_html_strings``.
    """
    copies = {}
    values = set(table.values())
    for m in JS_STRING.finditer(source):
        literal = next(g for g in m.groups() if g is not None)
        if not DEVANAGARI.search(literal):
            continue
        keyed = re.search(r"(\w+)\s*:\s*$", source[:m.start()])
        if keyed and keyed.group(1) in table:
            copies[keyed.group(1)] = literal
            if literal != table[keyed.group(1)]:
                errors.append("%s %s differs from %s" % (rel, keyed.group(1), STRINGS_REL))
        elif literal not in values:
            errors.append("%s has Hindi text %r that is not in %s" % (rel, literal[:40], STRINGS_REL))
    for fn, key in JS_KEY_CALL.findall(source):
        if key not in table:
            errors.append("%s uses string key %s, which is not in %s" % (rel, key, STRINGS_REL))
        elif fn == "setStatus" and key not in copies:
            errors.append("%s setStatus key %s has no Hindi fallback copy" % (rel, key))


def check(root=ROOT):
    root = Path(root)
    errors = []

    table = load_strings(root, errors)

    manifest_path = root / "manifest.webmanifest"
    manifest = {}
    if not manifest_path.is_file():
        errors.append("manifest.webmanifest missing")
    else:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for key in ("name", "short_name"):
            if not DEVANAGARI.search(manifest.get(key, "")):
                errors.append("manifest %s must contain Devanagari text" % key)
        for key, want in (("lang", "hi"), ("start_url", "/"), ("scope", "/"),
                          ("display", "standalone")):
            if manifest.get(key) != want:
                errors.append("manifest %s must be %r" % (key, want))
        for key in ("theme_color", "background_color"):
            if not manifest.get(key):
                errors.append("manifest %s missing" % key)
        for key, string in (("name", "app_title"), ("short_name", "app_short_name")):
            if table and manifest.get(key) != table.get(string):
                errors.append("manifest %s must equal %s %s" % (key, STRINGS_REL, string))
        sizes_seen = set()
        maskable = False
        for icon in manifest.get("icons", []):
            src = icon.get("src", "")
            path = root / src
            if not src.startswith("icons/") or not path.is_file():
                errors.append("icon %r must exist under icons/" % src)
                continue
            if icon.get("type") != "image/png":
                errors.append("icon %s must declare type image/png" % src)
            declared = icon.get("sizes", "")
            try:
                actual = png_size(path)
            except ValueError as exc:
                errors.append("icon %s: %s" % (src, exc))
                continue
            if declared != "%dx%d" % actual:
                errors.append("icon %s declares %s but is %dx%d" % ((src, declared) + actual))
                continue
            sizes_seen.add(declared)
            if "maskable" in icon.get("purpose", "").split():
                maskable = True
        for need in ("192x192", "512x512"):
            if need not in sizes_seen:
                errors.append("manifest lacks a %s icon" % need)
        if not maskable:
            errors.append("no icon has purpose including maskable")

    index_path = root / "index.html"
    html = ""
    fonts = []
    tokens = {}
    if not index_path.is_file():
        errors.append("index.html missing")
    else:
        html = index_path.read_text(encoding="utf-8")
        if not re.search(r"<html[^>]*\blang=[\"']hi[\"']", html):
            errors.append('index.html must declare <html lang="hi">')
        if not re.search(r"<link[^>]*rel=[\"']manifest[\"'][^>]*manifest\.webmanifest", html):
            errors.append("index.html must link manifest.webmanifest")
        if not re.search(r"<meta[^>]*name=[\"']viewport[\"'][^>]*width=device-width", html):
            errors.append("index.html needs a width=device-width viewport meta tag")
        scripts = ""
        for src in re.findall(r"<script[^>]*\bsrc=[\"']([^\"']+)", html):
            if (root / src).is_file():
                source = (root / src).read_text(encoding="utf-8")
                scripts += source
                check_js_strings(src, source, table, errors)
        if not re.search(r"serviceWorker\s*\.\s*register\(\s*[\"']/?sw\.js", html + scripts):
            errors.append("shell must register sw.js")
        if STRINGS_REL not in scripts:
            errors.append("shell scripts must load %s" % STRINGS_REL)
        check_html_strings(html, table, errors)
        stylesheets = re.findall(
            r"""<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']""", html)
        if not stylesheets:
            errors.append("index.html links no stylesheet")
        for href in stylesheets:
            if (root / href).is_file():
                css_tokens, css_fonts = check_css(root, root / href, errors)
                tokens.update(css_tokens)
                fonts += css_fonts
        for href in re.findall(
                r"""<link[^>]*rel=["']preload["'][^>]*href=["']([^"']+)["'][^>]*as=["']font["']""", html):
            if posixpath.normpath(href) not in fonts:
                errors.append("index.html preloads %s, which no @font-face loads" % href)
        # Browser chrome colours must come from the same tokens as the page.
        meta = re.search(r"""<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)""", html)
        for where, value, token in (
                ("index.html theme-color", meta.group(1) if meta else None, "--color-primary"),
                ("manifest theme_color", manifest.get("theme_color"), "--color-primary"),
                ("manifest background_color", manifest.get("background_color"), "--color-bg")):
            if token in tokens and (value or "").lower() != tokens[token].lower():
                errors.append("%s must equal the %s token (%s)" % (where, token, tokens[token]))

    sw_path = root / "sw.js"
    precache = []
    if not sw_path.is_file():
        errors.append("sw.js missing")
    else:
        sw = sw_path.read_text(encoding="utf-8")
        check_js_strings("sw.js", sw, table, errors)
        for event in ("install", "activate", "fetch"):
            if not re.search(r"addEventListener\(\s*[\"']%s[\"']" % event, sw):
                errors.append("sw.js lacks a %s handler" % event)
        if not re.search(r"CACHE_NAME\s*=", sw):
            errors.append("sw.js needs a versioned CACHE_NAME")
        if "caches.delete" not in sw:
            errors.append("sw.js activate must delete old caches")
        if not re.search(r"mode\s*===\s*[\"']navigate[\"']", sw):
            errors.append("sw.js must handle navigation requests")
        entries = parse_precache(sw)
        if entries is None:
            errors.append("sw.js needs a PRECACHE list")
        else:
            precache = precache_files(root, entries)
            names = {p.relative_to(root).as_posix() for p in precache}
            required = {"index.html", "manifest.webmanifest"}
            required |= {i.get("src") for i in manifest.get("icons", [])}
            required |= set(re.findall(
                r"""(?:href|src)=["']([^"']+\.(?:css|js|woff2?|ttf))["']""", html))
            required |= set(fonts) | {STRINGS_REL}
            for need in sorted(required - names):
                errors.append("sw.js PRECACHE lacks %s" % need)
            total = 0
            for p in precache:
                if not p.is_file():
                    errors.append("PRECACHE entry %s does not exist" % p.relative_to(root))
                else:
                    total += p.stat().st_size
            if total > MAX_PRECACHE_BYTES:
                errors.append("precached assets total %d bytes (> %d)" % (total, MAX_PRECACHE_BYTES))

    errors += js_syntax_errors(root)

    shell = [root / n for n in ("index.html", "manifest.webmanifest", "sw.js")]
    shell += [p for p in precache if p.suffix in (".css", ".js", ".json", ".html", ".webmanifest")]
    for p in dict.fromkeys(shell):
        if not p.is_file():
            continue
        for url in URL_RE.findall(p.read_text(encoding="utf-8")):
            if not url.startswith(URL_ALLOWLIST):
                errors.append("%s references foreign origin %s" % (p.relative_to(root), url))

    return errors


def main():
    errors = check()
    for line in errors:
        print("FAIL:", line)
    if not errors:
        print("PWA shell OK")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
