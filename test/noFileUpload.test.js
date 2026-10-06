// No upload path (issue #16): the roll is only ever downloaded for a ward
// picked from the bundled catalogue. Scans every source file in the repo for
// a file-input element, run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules']);
const BINARY = /\.(pdf|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|gz)$/i;

// Built from parts so this file does not match its own patterns.
const FILE = 'fi' + 'le';
const PATTERNS = [
  new RegExp(`type\\s*=\\s*["']?${FILE}\\b`, 'i'),
  new RegExp(`setAttribute\\(\\s*["']type["']\\s*,\\s*["']${FILE}["']`, 'i'),
  new RegExp(`\\.type\\s*=\\s*["']${FILE}["']`, 'i'),
  new RegExp(`show(Open|Save)${FILE[0].toUpperCase()}${FILE.slice(1)}Picker`),
];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dot entries (.git, editor and tool state) are not source.
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && !BINARY.test(entry.name)) yield path;
  }
}

test('no file-input element or file picker anywhere in the source', () => {
  const files = [...sourceFiles(ROOT)];
  assert.ok(files.some((f) => f.endsWith('index.html')));
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      if (pattern.test(text)) hits.push(`${relative(ROOT, file)}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the scan would catch a file input', () => {
  const sample = '<input ' + 'type="' + FILE + '" accept="application/pdf">';
  assert.ok(PATTERNS.some((p) => p.test(sample)));
});
