// Serialise the master glyph table in the layout glyphtable.py writes
// (json.dump with indent=0, ensure_ascii=False), so rebuilding or extending
// it keeps the glyph entries byte-identical.

import { writeFile } from "node:fs/promises";

export function serialiseTable(table) {
  return JSON.stringify(table, null, 1).replace(/^ +/gm, "");
}

export async function writeTable(path, table) {
  await writeFile(path, serialiseTable(table));
}
