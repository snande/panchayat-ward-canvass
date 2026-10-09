"""Turn decode.py's entries.json into an expected-entries file for the JS tests.

    python expected.py /tmp/out/entries.json ../../fixtures/sec/<district>/<roll>-expected.json

Keeps, per serial and in decode.py's order, the fields the JS decoder is
checked on (test/secFixtures.test.js): serial, name, relative, age, gender,
house and struck. decode.py's `rel` becomes `relative` and its `deleted`
becomes `struck`; strings are NFC-normalised, as decodeRoll returns them.
"""
import json, sys, unicodedata

def nfc(v):
    return unicodedata.normalize("NFC", v) if isinstance(v, str) else v

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    entries = json.load(open(src, encoding="utf-8"))
    out = [{
        "serial": e["serial"],
        "name": nfc(e.get("name")),
        "relative": nfc(e.get("rel")),
        "age": e.get("age"),
        "gender": nfc(e.get("gender")),
        "house": nfc(e.get("house")),
        "struck": bool(e["deleted"]),
    } for e in entries]
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(dst, "entries:", len(out), "struck:", sum(1 for e in out if e["struck"]))
