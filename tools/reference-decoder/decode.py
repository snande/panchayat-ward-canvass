"""Reference decoder for Rajasthan SEC 2026 panchayat roll PDFs (iTextSharp text layer).

Per PDF: hash every embedded Arial Unicode MS subset glyph's outline with the canonical
form in glyphtable.py, look it up in master-glyph-table.json for its Unicode expansion,
map each 1-byte text code to that expansion, assemble each text line from its runs,
reorder visual glyph order to logical Unicode, then parse the lines into voter records.
"""
import json, re, sys
import pypdf
from fontTools.ttLib import TTFont
from glyphtable import glyph_hash

VIRAMA, I_MATRA, RA, NUKTA = 0x94D, 0x93F, 0x930, 0x93C
def is_cons(c): return 0x915 <= c <= 0x939 or 0x958 <= c <= 0x95F
def is_vsign(c): return 0x93E <= c <= 0x94C or c in (0x962, 0x963)
def is_mark(c): return c in (0x901, 0x902, 0x903)
def is_combining(c): return is_vsign(c) or is_mark(c) or c in (VIRAMA, NUKTA)

def reorder(cps):
    """Visual to logical order.
    i-matra (U+093F) is drawn before its consonant cluster: move it, with any marks drawn
    with it, after the cluster. A standalone reph (ra, virama) is drawn after the syllable
    it precedes logically: move it to the start of that syllable's consonant cluster."""
    out, i, n = [], 0, len(cps)
    while i < n:
        c = cps[i]
        if c == I_MATRA:
            j = i + 1; reph = []
            if j + 1 < n and cps[j] == RA and cps[j+1] == VIRAMA: reph = [RA, VIRAMA]; j += 2   # reph fused into the i-matra glyph
            marks = []
            while j < n and is_mark(cps[j]): marks.append(cps[j]); j += 1
            cluster = []
            while j < n and (is_cons(cps[j]) or cps[j] in (VIRAMA, NUKTA)):
                cluster.append(cps[j]); j += 1
                if cps[j-1] in (VIRAMA, NUKTA): continue
                if j < n and cps[j] in (VIRAMA, NUKTA): continue
                break
            out += reph + cluster + [I_MATRA] + marks; i = j; continue
        if c == RA and i + 1 < n and cps[i+1] == VIRAMA and out:
            k = len(out)
            while k > 0 and (is_vsign(out[k-1]) or is_mark(out[k-1])): k -= 1
            while k > 0 and (is_cons(out[k-1]) or out[k-1] == NUKTA):
                k -= 1
                if k > 0 and out[k-1] == VIRAMA: k -= 1
                else: break
            out[k:k] = [RA, VIRAMA]; i += 2; continue
        out.append(c); i += 1
    return out

def subset_code_map(font_bytes, table, tmp):
    with open(tmp, "wb") as fh: fh.write(font_bytes)
    sub = TTFont(tmp); gs = sub.getGlyphSet(); m = {}
    for g in sub.getGlyphOrder():
        if not g.startswith("uniF0"): continue
        code = int(g[3:], 16) - 0xF000
        h, canon = glyph_hash(sub, gs, g)
        if h == "": m[code] = [0x20]; continue          # empty outline: the space glyph
        e = table.get(h); m[code] = e["codepoints"] if e else None
    return m

TOK = re.compile(rb"/(\w+)\s+[\d.]+\s+Tf|([-\d.]+)\s+([-\d.]+)\s+Td|([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm|(\()|(BT)", re.S)
ESC = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12, ord("("): 40, ord(")"): 41, ord("\\"): 92}
def read_literal(data, i):
    """Parse a PDF literal string starting at the '(' at data[i]; return (bytes, index after ')')."""
    out, depth, i = bytearray(), 1, i + 1
    while i < len(data) and depth:
        b = data[i]
        if b == 0x5C:
            n = data[i+1]
            if 0x30 <= n <= 0x37:
                j = i + 1; v = 0
                while j < len(data) and j < i + 4 and 0x30 <= data[j] <= 0x37: v = v * 8 + (data[j] - 0x30); j += 1
                out.append(v & 0xFF); i = j; continue
            if n in (10, 13): i += 2; continue
            out.append(ESC.get(n, n)); i += 2; continue
        if b == 0x28: depth += 1
        elif b == 0x29:
            depth -= 1
            if depth == 0: return bytes(out), i + 1
        out.append(b); i += 1
    return bytes(out), i

def page_lines(reader, idx, table, tmpdir, debug_codes=False):
    """Assemble text lines. A positioning move starts a new line unless the next piece
    continues the same row: it starts with a combining mark or a reph, it is placed within
    two units of the previous move, or the previous piece was marks only."""
    page = reader.pages[idx]
    xobjs = page["/Resources"].get_object().get("/XObject") or {}
    form = next(x.get_object() for x in xobjs.values() if x.get_object().get("/Subtype") == "/Form")
    fonts = form["/Resources"].get_object()["/Font"]
    maps, unmatched, roles = {}, [], {}
    for fname, fobj in fonts.items():
        fobj = fobj.get_object(); base = str(fobj["/BaseFont"])
        roles[fname.strip("/")] = "serial" if "TimesNewRoman" in base else ("latin" if base.endswith("+Arial") else "hindi")
        if "ArialUnicodeMS" in base:
            maps[fname.strip("/")] = subset_code_map(fobj["/FontDescriptor"].get_object()["/FontFile2"].get_object().get_data(), table, f"{tmpdir}/sub_{idx}_{fname.strip('/')}.ttf")
            unmatched += [f"{fname}:{hex(c)}" for c, v in maps[fname.strip("/")].items() if v is None]
    data = form.get_data()
    lines, cur, cur_font, pos, pending = [], None, None, (0.0, 0.0), None
    def flush():
        nonlocal cur
        if cur and cur["cps"]:
            cur["text"] = "".join(chr(c) for c in reorder(cur["cps"])).strip()
            if cur["text"]: lines.append(cur)
        cur = None
    i = 0
    while True:
        m = TOK.search(data, i)
        if not m: break
        i = m.end()
        if m.group(1): cur_font = m.group(1).decode(); continue
        if m.group(11): pos = (0.0, 0.0); pending = pos; continue
        if m.group(2): pos = (pos[0] + float(m.group(2)), pos[1] + float(m.group(3))); pending = pos; continue
        if m.group(4): pos = (float(m.group(8)), float(m.group(9))); pending = pos; continue
        raw, i = read_literal(data, m.start(10))
        if not re.match(rb"\s*Tj", data[i:i+6]): continue
        if cur_font in maps:
            piece = []
            for b in raw:
                seq = maps[cur_font].get(b); piece += seq if seq else [0xFFFD]
        else:
            piece = [ord(ch) for ch in raw.decode("latin1")]
        if pending is not None:
            same_row = cur is not None and abs(pending[1] - cur["y"]) < 1.5
            starts_combining = bool(piece) and (is_combining(piece[0]) or piece[:2] == [RA, VIRAMA])
            near = cur is not None and abs(pending[0] - cur["xend"]) < 2.0
            if not (same_row and (starts_combining or near or cur["marks_only"])):
                flush(); cur = {"x": pending[0], "y": pending[1], "cps": [], "fonts": set(), "raw": [], "xend": pending[0], "marks_only": False}
            cur["xend"] = pending[0]; pending = None
        if cur is None: cur = {"x": 0.0, "y": 0.0, "cps": [], "fonts": set(), "raw": [], "xend": 0.0, "marks_only": False}
        cur["marks_only"] = all(is_combining(c) for c in piece) or piece == [RA, VIRAMA]
        cur["fonts"].add(roles.get(cur_font, cur_font)); cur["cps"] += piece
        if debug_codes: cur["raw"].append((cur_font, [hex(b) for b in raw]))
    flush()
    return lines, unmatched

EPIC = re.compile(r"(UPY\d+|RJ/\d+/\d+/\d+|[A-Z]{3}\d{6,7})")
LABEL_NAME = re.compile(r"नाम\s*:?")
LABEL_REL = re.compile(r"(पति|पिता|माता|पत्नी|अन्य)\s+का\s+नाम\s*:?")
LABEL_HOUSE = re.compile(r"मकान\s+संख्या\s*:?")
LABEL_AGE = re.compile(r"आयु\s*:?")
LABEL_SEX = re.compile(r"लिं?ग\s*:?")

def parse_entries(lines):
    """Entries start at a 'नाम:' label and end at the bold serial. Every value sits on the row
    (same y) of its label: name on the नाम row, relative on the 'X का नाम' row, house on the
    मकान संख्या row, age and gender on the आयु row; the EPIC is a row of its own."""
    def same_row(a, b): return abs(a["y"] - b["y"]) < 2.0
    def finish(block, serial):
        e, labels = {"serial": serial, "deleted": False}, {}
        for ln in block:
            t = ln["text"]
            if LABEL_NAME.fullmatch(t): labels["name"] = ln
            elif LABEL_REL.fullmatch(t): labels["rel"] = ln; e["relation"] = t.split()[0]
            elif LABEL_HOUSE.fullmatch(t): labels["house"] = ln
            elif LABEL_AGE.fullmatch(t): labels["age"] = ln
        for ln in block:
            t = ln["text"]
            if ln in labels.values() or t in ("Photo is", "Available") or LABEL_SEX.fullmatch(t): continue
            if EPIC.fullmatch(t): e["epic"] = t; continue
            for key, lab in labels.items():
                if same_row(ln, lab) and ln["x"] > lab["x"] + 1:
                    if key == "age":
                        if re.fullmatch(r"\d+", t): e["age"] = int(t)
                        elif t in ("स्त्री", "पुरूष", "पुरुष", "अन्य"): e["gender"] = t
                        else: e.setdefault("extra", []).append(t)
                    elif key == "house": e["house"] = t
                    else: e[key] = (e[key] + " " + t) if key in e else t
                    break
            else:
                e.setdefault("extra", []).append(t)
        return e
    entries, block = [], []
    for ln in lines:
        t = ln["text"]
        if LABEL_NAME.fullmatch(t): block = [ln]; continue
        if "serial" in ln["fonts"] and re.fullmatch(r"\d+", t) and block:
            e = finish(block, int(t)); e["_serial_y"] = ln["y"]; entries.append(e); block = []; continue
        if "serial" in ln["fonts"] and t == "O" and entries and abs(entries[-1].get("_serial_y", 1e9) - ln["y"]) < 2.0:
            entries[-1]["deleted"] = True; continue
        if block: block.append(ln)
    return entries

if __name__ == "__main__":
    pdf, table_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    table = json.load(open(table_path))["glyphs"]
    reader = pypdf.PdfReader(pdf)
    all_entries, unmatched = [], []
    for idx in range(len(reader.pages)):
        lines, um = page_lines(reader, idx, table, out_dir, debug_codes=(idx == 2)); unmatched += um
        with open(f"{out_dir}/page{idx+1:02d}.txt", "w") as fh:
            for ln in lines: fh.write(f"{''.join(sorted(ln['fonts']))}\t{ln['x']:.1f}\t{ln['y']:.1f}\t{ln['text']}" + (f"\t{ln['raw']}" if idx == 2 and "लिग" in ln["text"] else "") + "\n")
        if idx >= 2:
            ents = parse_entries(lines)
            for e in ents: e["page"] = idx + 1
            all_entries += ents
    # the supplement's deletion list repeats entries already in the original list: keep one per serial
    seen, deduped = set(), []
    for e in all_entries:
        e.pop("_serial_y", None)
        if e["serial"] in seen:
            prev = next(x for x in deduped if x["serial"] == e["serial"])
            prev["deleted"] = prev["deleted"] or e["deleted"]; continue
        seen.add(e["serial"]); deduped.append(e)
    all_entries = sorted(deduped, key=lambda e: e["serial"])
    json.dump(all_entries, open(f"{out_dir}/entries.json", "w"), ensure_ascii=False, indent=1)
    print("deleted:", sum(1 for e in all_entries if e["deleted"]), "remaining:", sum(1 for e in all_entries if not e["deleted"]))
    print("unmatched glyphs:", unmatched or "none")
    print("entries:", len(all_entries), "first/last serial:", all_entries[0].get("serial"), all_entries[-1].get("serial"))
    need = {"serial", "name", "rel", "relation", "age", "gender", "house"}
    bad = [e for e in all_entries if not need <= e.keys() or "extra" in e or "�" in json.dumps(e, ensure_ascii=False)]
    print("entries with problems:", len(bad))
    for e in bad[:6]: print("  BAD", e)
    for e in all_entries[:6]: print(e)
    serials = [e["serial"] for e in all_entries]
    print("serial sequence ok:", serials == list(range(1, len(serials) + 1)))
