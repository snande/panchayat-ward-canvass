// Write a minimal uncompressed PDF for tests. `objects` maps object numbers
// to their body text (a dictionary, or {dict, stream} for a stream object).
// With `xref: false` the file has no xref table, so readers must scan.

export function buildPdf(objects, { root = 1, xref = true } = {}) {
  let out = "%PDF-1.4\n";
  const offsets = {};
  const nums = Object.keys(objects).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    offsets[n] = out.length;
    const o = objects[n];
    if (typeof o === "string") out += `${n} 0 obj\n${o}\nendobj\n`;
    else out += `${n} 0 obj\n<<${o.dict}/Length ${o.stream.length}>>\nstream\n${o.stream}\nendstream\nendobj\n`;
  }
  const size = Math.max(...nums) + 1;
  if (xref) {
    const at = out.length;
    out += `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) {
      out += n in offsets ? `${String(offsets[n]).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
    }
    out += `trailer\n<</Size ${size}/Root ${root} 0 R>>\nstartxref\n${at}\n%%EOF\n`;
  } else {
    out += `trailer\n<</Size ${size}/Root ${root} 0 R>>\n%%EOF\n`;
  }
  return new TextEncoder().encode(out);
}
