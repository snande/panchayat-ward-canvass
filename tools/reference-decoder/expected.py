"""Expected-entries fixture for a roll PDF, from the reference decoder.

Runs decode.py on the PDF and writes <pdf without .pdf>.expected.json next to it: every
entry of the roll, struck-off ones included, in serial order, with only the fields the
app keeps (src/roll/rollStore.js STORED_FIELDS): serial, name, relative, age, gender,
house, struck. Strings are NFC-normalised, as src/decoder/decodeRoll.js returns them.
One entry per line, so a mismatch reads as a one-line diff.

    cd tools/reference-decoder
    ../../venv/bin/python expected.py ../../fixtures/sec/bharatpur/ARAUDA-ward-001.pdf
"""
import json, os, sys, tempfile, unicodedata

FIELDS = ("serial", "name", "relative", "age", "gender", "house", "struck")

def nfc(v): return unicodedata.normalize("NFC", v) if isinstance(v, str) else v

def project(entries):
    """decode.py entries -> fixture rows ("rel" is "relative", "deleted" is "struck")."""
    return [{"serial": e["serial"], "name": nfc(e.get("name")), "relative": nfc(e.get("rel")),
             "age": e.get("age"), "gender": nfc(e.get("gender")), "house": nfc(e.get("house")),
             "struck": bool(e["deleted"])} for e in entries]

def dumps(rows):
    return "[\n" + ",\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n]\n"

if __name__ == "__main__":
    from decode import decode_pdf
    here = os.path.dirname(os.path.abspath(__file__))
    table_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "../../src/decoder/master-glyph-table.json")
    pdf = sys.argv[1]
    table = json.load(open(table_path))["glyphs"]
    with tempfile.TemporaryDirectory() as tmp:
        entries, unmatched = decode_pdf(pdf, table, tmp)
    if unmatched: sys.exit(f"unmatched glyphs: {unmatched}")
    rows = project(entries)
    out = pdf[:-len(".pdf")] + ".expected.json"
    with open(out, "w", encoding="utf-8") as fh: fh.write(dumps(rows))
    print(out, "entries:", len(rows), "struck:", sum(r["struck"] for r in rows))
