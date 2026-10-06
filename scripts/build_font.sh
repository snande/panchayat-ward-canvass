#!/bin/sh
# Builds fonts/noto-sans-devanagari-subset.woff2, the self-hosted shell font.
#
# Source: Noto Sans Devanagari Regular (SIL Open Font License 1.1) from the
# notofonts/devanagari project. The subset keeps the Devanagari blocks, ZWNJ/ZWJ,
# the dotted circle, the rupee sign and Basic Latin, plus every OpenType layout
# feature so conjuncts and matras shape correctly. Keep the ranges in sync with
# the unicode-range of the @font-face rule in css/app.css.
#
# Needs network access and fonttools with brotli:
#   python3 -m pip install fonttools brotli
# Run from the repo root: sh scripts/build_font.sh
set -eu

FONT_URL="${FONT_URL:-https://github.com/notofonts/devanagari/raw/main/fonts/NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Regular.ttf}"
OFL_URL="${OFL_URL:-https://github.com/notofonts/devanagari/raw/main/OFL.txt}"
UNICODES="U+0020-007E,U+00A0,U+0900-097F,U+200C-200D,U+20B9,U+25CC,U+A8E0-A8FF"
OUT="fonts/noto-sans-devanagari-subset.woff2"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/source.ttf" "$FONT_URL"
mkdir -p fonts
curl -fsSL -o fonts/OFL.txt "$OFL_URL"

python3 -m fontTools.subset "$tmp/source.ttf" \
  --unicodes="$UNICODES" \
  --layout-features='*' \
  --flavor=woff2 \
  --no-hinting \
  --desubroutinize \
  --name-IDs='*' \
  --output-file="$OUT"

ls -l "$OUT"
python3 scripts/check_pwa_shell.py
