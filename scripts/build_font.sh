#!/bin/sh
# Builds fonts/noto-sans-devanagari-subset.woff2, the self-hosted shell font,
# and fetches its licence to fonts/OFL.txt.
#
# Source: Noto Sans Devanagari Regular (SIL Open Font License 1.1) from the
# notofonts/devanagari project. The subset keeps Basic Latin, NBSP, Devanagari
# (U+0900-097F), Devanagari Extended (U+A8E0-A8FF), ZWNJ/ZWJ, the rupee sign and
# the dotted circle, plus every OpenType layout feature so conjuncts and matras
# shape correctly. Code points the source font has no glyph for are dropped.
# Keep UNICODES in sync with the unicode-range of the @font-face in styles.css.
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
# Show which subset ranges actually made it into the font.
python3 - "$OUT" <<'EOF'
import sys
from fontTools.ttLib import TTFont
cmap = TTFont(sys.argv[1]).getBestCmap()
for lo, hi in ((0x0900, 0x097F), (0xA8E0, 0xA8FF), (0x0020, 0x007E)):
    have = sum(1 for cp in range(lo, hi + 1) if cp in cmap)
    print("U+%04X-%04X: %d glyph-mapped code points" % (lo, hi, have))
EOF
python3 scripts/check_pwa_shell.py
