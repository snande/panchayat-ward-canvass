import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PdfFile, textLayerCodes, embeddedTrueTypeFonts } from "../src/pdf/embeddedFonts.js";
import { buildPdf } from "./helpers/pdfBuilder.js";

const codes = (used, num) => [...(used.get(num) || [])].sort((a, b) => a - b).map((c) => String.fromCharCode(c)).join("");

// Page 3 draws with fonts 10 (/F1) and 11 (/F2); forms 20 (no /Resources)
// and 21 (own resources with /F3 = font 12).
function samplePdf(opts) {
  return buildPdf({
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[3 0 R]/Count 1/Resources<</Font<</F1 10 0 R/F2 11 0 R>>/XObject<</Fa 20 0 R/Fb 21 0 R>>>>>>",
    3: "<</Type/Page/Parent 2 0 R/Contents 4 0 R>>",
    4: { dict: "", stream: "BT /F1 9 Tf (a) Tj ET q BT /F2 9 Tf (b) Tj ET Q BT (c) Tj ET /Fa Do /Fb Do q /F2 9 Tf /Fa Do Q" },
    10: "<</Type/Font/Subtype/TrueType/BaseFont/AAAAAA+ArialUnicodeMS>>",
    11: "<</Type/Font/Subtype/TrueType/BaseFont/AAAAAB+Arial>>",
    12: "<</Type/Font/Subtype/TrueType/BaseFont/AAAAAC+Arial>>",
    20: { dict: "/Type/XObject/Subtype/Form", stream: "BT (d) Tj ET BT /F2 9 Tf (\\(e\\)) Tj ET" },
    21: { dict: "/Type/XObject/Subtype/Form/Resources<</Font<</F3 12 0 R>>>>", stream: "BT (f) Tj /F3 9 Tf [(g) 120 (h)] TJ ET" },
  }, opts);
}

test("q/Q save and restore the current font; forms inherit the font and resources at Do", async () => {
  const used = await textLayerCodes(new PdfFile(samplePdf()));
  // (a) and (c) with F1, (b) with F2 inside q/Q; form Fa (no Resources) draws
  // (d) with F1 then (e) with F2; form Fb draws (f) with the inherited F1 and
  // (g)(h) with its own F3; the second Fa runs with F2 current.
  assert.equal(codes(used, 10), "acdf");
  assert.equal(codes(used, 11), "()bde");
  assert.equal(codes(used, 12), "gh");
});

test("objects are located through the xref table", () => {
  const pdf = new PdfFile(samplePdf());
  assert.equal(pdf.located, "xref");
  assert.equal(pdf.get(10).get("BaseFont").name, "AAAAAA+ArialUnicodeMS");
});

test("without an xref, the scan skips stream bodies and strings", async () => {
  const bytes = buildPdf({
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    3: "<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    // The content mentions "5 0 obj" as text; it must not shadow object 5.
    4: { dict: "", stream: "BT /F1 9 Tf (5 0 obj) Tj ET\n5 0 obj\n<</Type/Font/BaseFont/Fake>>\nendobj" },
    5: "<</Type/Font/Subtype/TrueType/BaseFont/AAAAAA+ArialUnicodeMS>>",
  }, { xref: false });
  const pdf = new PdfFile(bytes);
  assert.equal(pdf.located, "scan");
  assert.equal(pdf.get(5).get("BaseFont").name, "AAAAAA+ArialUnicodeMS");
  const used = await textLayerCodes(pdf);
  assert.equal(codes(used, 5), " 05bjo");
});

test("a Type0 Arial Unicode MS font fails loudly", async () => {
  const bytes = buildPdf({
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[]/Count 0>>",
    3: "<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+ArialUnicodeMS/Encoding/Identity-H>>",
  });
  await assert.rejects(embeddedTrueTypeFonts(bytes), /Type0/);
});

test("the fixture's four Arial Unicode MS subsets and their shown codes", async () => {
  const fonts = await embeddedTrueTypeFonts(await readFile(new URL("../fixtures/badli-ward1.pdf", import.meta.url)));
  assert.deepEqual(fonts.map((f) => `${f.baseFont}@${f.objNum}`), [
    "AAAAAB+ArialUnicodeMS@55", "AAAAAA+ArialUnicodeMS@56", "AAAAAB+ArialUnicodeMS@89", "AAAAAA+ArialUnicodeMS@90",
  ]);
  assert.deepEqual(fonts.map((f) => f.usedCodes.size), [73, 45, 90, 23]);
});
