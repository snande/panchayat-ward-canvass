#!/usr/bin/env python3
"""Repo-ci checks for the installable PWA shell (stdlib only).

Run from anywhere: ``python3 scripts/check_pwa_shell.py``. Exits non-zero and
prints one line per problem when the shell breaks an acceptance criterion.
"""
import json
import posixpath
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_PRECACHE_BYTES = 400 * 1024
DEVANAGARI = re.compile("[ऀ-ॿ]")
# Absolute URLs (any host, including localhost and IPs), plus protocol-relative
# URLs that open a string literal, an attribute value or url(...).
URL_RE = re.compile(
    r"""https?://[^\s"'<>)]+|(?<=["'(])//[A-Za-z0-9\[][^\s"'<>)]*""", re.I
)
# Namespace/spec URLs that are identifiers, not network requests.
URL_ALLOWLIST = ("http://www.w3.org/",)


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
    for line in sw_text[start.end():].splitlines():
        code = line.split("//", 1)[0]
        entries += re.findall(r"""["']([^"']*)["']""", code)
        if "]" in code:
            break
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


def check(root=ROOT):
    root = Path(root)
    errors = []

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
    if not index_path.is_file():
        errors.append("index.html missing")
    else:
        html = index_path.read_text(encoding="utf-8")
        if not re.search(r"<html[^>]*\blang=[\"']hi[\"']", html):
            errors.append('index.html must declare <html lang="hi">')
        if not re.search(r"<link[^>]*rel=[\"']manifest[\"'][^>]*manifest\.webmanifest", html):
            errors.append("index.html must link manifest.webmanifest")
        if not re.search(r"<meta[^>]*name=[\"']viewport[\"']", html):
            errors.append("index.html needs a viewport meta tag")
        scripts = html
        for src in re.findall(r"<script[^>]*\bsrc=[\"']([^\"']+)", html):
            if (root / src).is_file():
                scripts += (root / src).read_text(encoding="utf-8")
        if not re.search(r"serviceWorker\s*\.\s*register\(\s*[\"']/?sw\.js", scripts):
            errors.append("shell must register sw.js")

    sw_path = root / "sw.js"
    precache = []
    if not sw_path.is_file():
        errors.append("sw.js missing")
    else:
        sw = sw_path.read_text(encoding="utf-8")
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

    shell = [root / n for n in ("index.html", "manifest.webmanifest", "sw.js")]
    shell += [p for p in precache if p.suffix in (".css", ".js", ".html", ".webmanifest")]
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
