"""Build the master glyph table from Arial Unicode MS with a portable outline hash.

Canonical outline (the hash input), defined so a JavaScript port with opentype.js
produces the identical string:
  * Flatten composites; coordinates are integer font units (both fonts share upem).
  * Each contour becomes a list of quadratic segments. A TrueType run of several
    off-curve points is split at the implied on-curve midpoints, so every segment
    is "L x,y" (line to an on-curve point) or "Q cx,cy x,y" (one control point,
    one on-curve end point). A contour that has no on-curve point at all gets a
    synthetic start at the midpoint of its first two off-curve points.
  * Each contour's segment list is rotated so it starts at the lexicographically
    smallest (x, y) on-curve point (ties: the first occurrence), written as
    "M x,y" followed by the segments in order ending back at that point.
  * Contours are sorted as strings; the glyph string is the contours joined by ";".
  * hash = sha256(utf8(glyph string)), hex. An empty glyph (space) hashes "".
"""
import hashlib, json, sys
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.basePen import decomposeQuadraticSegment

def contours_from_pen(value):
    contours, cur, start = [], [], None
    for op, args in value:
        if op == "moveTo":
            cur, start = [], tuple(int(round(v)) for v in args[0]); cur.append(("M", start))
        elif op == "lineTo":
            cur.append(("L", tuple(int(round(v)) for v in args[0])))
        elif op == "qCurveTo":
            pts = [tuple(int(round(v)) for v in p) for p in args]
            if pts[-1] is None or args[-1] is None:
                # closed contour with no on-curve point: fontTools passes None last
                pts = [tuple(int(round(v)) for v in p) for p in args[:-1]]
                mid = ((pts[0][0] + pts[1][0]) // 2, (pts[0][1] + pts[1][1]) // 2)
                cur = [("M", mid)]
                seq = pts[1:] + pts[:1] + [mid]
                for off, on in decomposeQuadraticSegment(seq):
                    cur.append(("Q", (int(off[0]), int(off[1]), int(on[0]), int(on[1]))))
                continue
            for off, on in decomposeQuadraticSegment(pts):
                cur.append(("Q", (int(off[0]), int(off[1]), int(on[0]), int(on[1]))))
        elif op == "curveTo":
            raise ValueError("cubic in TrueType glyph")
        elif op in ("closePath", "endPath"):
            if cur: contours.append(cur); cur = []
    if cur: contours.append(cur)
    return contours

def canonical(value):
    out = []
    for c in contours_from_pen(value):
        start = c[0][1]; segs = c[1:]
        # ensure the contour is closed back to start
        last = segs[-1][1][-2:] if segs else start
        if tuple(last) != tuple(start): segs.append(("L", start))
        # on-curve points reached by each segment, in order; rotate to the smallest
        ends = [tuple(s[1][-2:]) for s in segs]
        if not ends: out.append(f"M {start[0]},{start[1]}"); continue
        k = min(range(len(ends)), key=lambda i: ends[i])
        rot = segs[k+1:] + segs[:k+1]
        s0 = ends[k]
        parts = [f"M {s0[0]},{s0[1]}"]
        for op, a in rot:
            parts.append("L %d,%d" % a if op == "L" else "Q %d,%d %d,%d" % a)
        out.append("|".join(parts))
    return ";".join(sorted(out))

def contour_shapes(glyph_set, name):
    """Set of contour strings with each contour translated so its minimum point is the origin."""
    pen = DecomposingRecordingPen(glyph_set); glyph_set[name].draw(pen)
    shapes = []
    for c in contours_from_pen(pen.value):
        pts = [c[0][1]] + [tuple(seg[1][-2:]) for seg in c[1:]] + [tuple(seg[1][:2]) for seg in c[1:] if seg[0] == "Q"]
        mx, my = min(p[0] for p in pts), min(p[1] for p in pts)
        parts = []
        for op, a in c:
            if op == "M": parts.append("M %d,%d" % (a[0]-mx, a[1]-my))
            elif op == "L": parts.append("L %d,%d" % (a[0]-mx, a[1]-my))
            else: parts.append("Q %d,%d %d,%d" % (a[0]-mx, a[1]-my, a[2]-mx, a[3]-my))
        shapes.append("|".join(parts))
    return shapes

def glyph_hash(font, glyph_set, name):
    pen = DecomposingRecordingPen(glyph_set); glyph_set[name].draw(pen)
    s = canonical(pen.value)
    return ("" if not s else hashlib.sha256(s.encode()).hexdigest()), s

if __name__ == "__main__":
    master = TTFont(sys.argv[1]); gs = master.getGlyphSet(); cmap = master.getBestCmap()
    order = master.getGlyphOrder(); gid_of = {g: i for i, g in enumerate(order)}
    cp_of = {}
    for cp, g in cmap.items(): cp_of.setdefault(g, cp)
    gsub = master["GSUB"].table
    feats = {}
    for fr in gsub.FeatureList.FeatureRecord:
        for li in fr.Feature.LookupListIndex: feats.setdefault(li, set()).add(fr.FeatureTag)
    lig_rev, single_rev = {}, {}
    for li, lookup in enumerate(gsub.LookupList.Lookup):
        for st in lookup.SubTable:
            kind = lookup.LookupType
            if kind == 7: st = st.ExtSubTable; kind = st.LookupType
            if kind == 4:
                for first, ligs in st.ligatures.items():
                    for lig in ligs: lig_rev.setdefault(lig.LigGlyph, ([first] + list(lig.Component), sorted(feats.get(li, set()))))
            elif kind == 1:
                for inp, out in st.mapping.items(): single_rev.setdefault(out, (inp, sorted(feats.get(li, set()))))
    VIRAMA = 0x94D
    def is_cons(c): return 0x915 <= c <= 0x939 or 0x958 <= c <= 0x95F
    def expand(g, depth=0):
        """-> (codepoints, kind). Half/reph/below forms: consonant + virama; rakar (vatu/blwf of ra): virama + ra."""
        if g in cp_of: return [cp_of[g]], "base"
        if depth > 6: return None, "unresolved"
        if g in lig_rev:
            comps, tags = lig_rev[g]; out = []
            for n, c in enumerate(comps):
                seq, k = expand(c, depth + 1)
                if seq is None: return None, "unresolved"
                # The ra+virama glyph is a reph on its own, but inside a ligature after a
                # consonant it is the below-base ra (rakar): logical order is virama + ra.
                if n > 0 and seq == [0x930, VIRAMA] and out and is_cons(out[-1]): seq = [VIRAMA, 0x930]
                out += seq
            return out, "ligature"
        if g in single_rev:
            inp, tags = single_rev[g]; seq, _ = expand(inp, depth + 1)
            if seq is None: return None, "unresolved"
            tagset = set(tags)
            if tagset & {"half"}: return seq + [VIRAMA], "half"
            if tagset & {"pstf"}: return [VIRAMA] + seq, "post"
            if tagset & {"rphf"}: return seq + [VIRAMA], "reph"
            if tagset & {"blwf", "vatu"}: return [VIRAMA] + seq, "below"
            return seq, "variant"
        return None, "unresolved"
    # scope: Devanagari block + Vedic + basic Latin + general punctuation, and every glyph reachable from them by GSUB
    scope = set()
    for cp, g in cmap.items():
        if 0x0900 <= cp <= 0x097F or 0x0020 <= cp <= 0x007E or 0x00A0 <= cp <= 0x00FF or 0x2000 <= cp <= 0x206F or cp == 0x25CC: scope.add(g)
    frontier = set(scope); 
    while frontier:
        nxt = set()
        for out_g, (comps, _) in lig_rev.items():
            if out_g not in scope and all(c in scope for c in comps): nxt.add(out_g)
        for out_g, (inp, _) in single_rev.items():
            if out_g not in scope and inp in scope: nxt.add(out_g)
        scope |= nxt; frontier = nxt
    # A "variant" is a single substitution not tied to a shaping feature we interpret. When the
    # variant's outline is exactly the input glyph's contours plus the contours of a combining
    # mark (anusvara, candrabindu, visarga), the variant stands for input + mark.
    def real_contours(name):
        # drop degenerate contours (a single anchor point) that mark glyphs carry
        return sorted(c for c in contour_shapes(gs, name) if c.count("|") >= 2)
    mark_shapes = {cp: real_contours(cmap[cp]) for cp in (0x902, 0x901, 0x903) if cp in cmap}
    def contour_boxes(name):
        pen = DecomposingRecordingPen(gs); gs[name].draw(pen); boxes = []
        for c in contours_from_pen(pen.value):
            pts = [c[0][1]] + [tuple(seg[1][-2:]) for seg in c[1:]]
            if len(pts) < 3: continue
            boxes.append((min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)))
        return boxes
    I_MATRA_PLAIN_WIDTHS = (1260, 1450, 1590)   # the three hook lengths of a plain i-matra in this font
    def with_mark(g):
        """Decode the contextual variants of the i-matra and ii-matra that carry an extra mark.
        Returns the code points to append to the variant's base expansion, or None.
        The hook of an i-matra comes in three lengths; a hook wider than any of them has the
        reph fused into it (ra + virama, placed logically before the cluster the matra follows,
        see decode.reorder). An extra small round contour above the headline is an anusvara;
        a wide arc with a dot above it is a candrabindu. Mark contours are drawn at slightly
        different sizes than the standalone mark glyphs, so bounding boxes are compared."""
        if g not in single_rev: return None
        inp = single_rev[g][0]
        vb = contour_boxes(g); ib = contour_boxes(inp)
        if not vb or not ib: return None
        out = []
        main = max(vb, key=lambda b: (b[2]-b[0]) * (b[3]-b[1])); base_main = max(ib, key=lambda b: (b[2]-b[0]) * (b[3]-b[1]))
        root, hops = inp, 0
        while root not in cp_of and root in single_rev and hops < 6: root = single_rev[root][0]; hops += 1
        is_i_matra = cp_of.get(root) == 0x93F
        if is_i_matra and main[1] < 0 and main[3] > 1800 and all(abs(main[2] - w) > 10 for w in I_MATRA_PLAIN_WIDTHS):
            out += [0x930, VIRAMA]
        extras = [b for b in vb if b != main]
        if len(extras) == 1:
            x0, y0, x1, y1 = extras[0]
            if 150 <= x1 - x0 <= 400 and 150 <= y1 - y0 <= 400 and y0 > 1300: out.append(0x902)
            else: return None
        elif len(extras) == 2:
            big = max(extras, key=lambda b: b[2]-b[0])
            if big[2] - big[0] > 500 and big[1] > 1500: out.append(0x901)
            else: return None
        elif extras: return None
        if not out: return None
        if main != base_main and not (is_i_matra and [0x930, VIRAMA] == out[:2]) and len(extras) == 0: return None
        return out
    table = {}; collisions = 0; unresolved = 0; marked = 0
    for g in sorted(scope, key=lambda n: gid_of[n]):
        h, s = glyph_hash(master, gs, g)
        if not h: continue
        seq, kind = expand(g)
        if kind == "variant":
            mark = with_mark(g)
            if mark:
                if mark and seq[-len(mark):] == mark: mark = []          # the base expansion already carries it
                elif mark and mark[-1] in (0x901, 0x902) and seq[-1] == mark[-1]: mark = mark[:-1]
                if mark: seq = seq + mark; kind = "variant+mark"; marked += 1
        if seq is None: unresolved += 1
        entry = {"gid": gid_of[g], "name": g, "kind": kind, "codepoints": seq}
        if h in table: collisions += 1; continue
        table[h] = entry
    meta = {"source": "Arial Unicode MS (macOS /System/Library/Fonts/Supplemental/Arial Unicode.ttf)", "unitsPerEm": master["head"].unitsPerEm,
            "glyphs": len(table), "scope": "Devanagari U+0900-097F, basic Latin, Latin-1, general punctuation, U+25CC, plus every glyph reachable from them through GSUB", 
            "hash": "sha256 hex of the canonical outline string; see CANONICAL_OUTLINE.md"}
    json.dump({"meta": meta, "glyphs": table}, open(sys.argv[2], "w"), ensure_ascii=False, indent=0)
    print("scope glyphs:", len(scope), "table entries:", len(table), "collisions:", collisions, "unresolved:", unresolved, "variants with a mark:", marked, "upem:", meta["unitsPerEm"])
    kinds = {}
    for e in table.values(): kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    print("kinds:", kinds)
