import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUDGET_BYTES, FONT, parsePrecache, staticImports } from './check_startup_budget.mjs';

const SCRIPT = fileURLToPath(new URL('./check_startup_budget.mjs', import.meta.url));

function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// A minimal shell that passes: a classic js/app.js, a module js/picker.js
// that imports src/ui/dom.js, and a decoder only picker.js reaches by import().
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'startup-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'index.html': '<!DOCTYPE html><html lang="hi"><body>\n<!-- <script src="js/old.js"></script> -->\n'
      + '<script src="js/app.js"></script>\n<script type="module" src="js/picker.js"></script>\n</body></html>\n',
    'styles.css': 'body { margin: 0; }\n',
    'manifest.webmanifest': '{}\n',
    [FONT]: 'wOF2',
    'js/app.js': '"use strict";\nimport("../src/ui/dom.js");\n',
    'js/picker.js': "import { el } from '../src/ui/dom.js';\nconst load = () => import('../src/decoder/decodeRoll.js');\n",
    'src/ui/dom.js': 'export const el = 1;\n',
    'src/decoder/decodeRoll.js': 'export const decodeRoll = 1;\n',
    'sw.js': 'const PRECACHE = [\n  "./",\n  "index.html",\n  "styles.css",\n  "manifest.webmanifest",\n'
      + '  "js/app.js",\n  "js/picker.js",\n  // shared helpers\n  "src/ui/dom.js",\n  "' + FONT + '",\n];\n',
    ...overrides,
  };
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test('the real shell is within budget and prints its total in KB', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /startup critical path: \d+ files, \d+\.\d KB \(budget 350\.0 KB\)/);
});

test('a passing fixture exits 0', (t) => {
  const r = run(['--root', fixture(t)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('js/app.js statically importing the decoder fails', (t) => {
  const root = fixture(t, {
    'js/app.js': "import { decodeRoll } from '../src/decoder/decodeRoll.js';\n",
    'sw.js': 'const PRECACHE = ["index.html", "styles.css", "manifest.webmanifest", "js/app.js", "js/picker.js", '
      + '"src/ui/dom.js", "src/decoder/decodeRoll.js", "' + FONT + '"];\n',
  });
  const r = run(['--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /static import reaches the decoder: js\/app\.js -> src\/decoder\/decodeRoll\.js/);
});

test('a page module reaching the decoder transitively fails', (t) => {
  const root = fixture(t, {
    'src/ui/dom.js': "export { decodeRoll } from '../decoder/decodeRoll.js';\n",
  });
  const r = run(['--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /js\/picker\.js -> src\/ui\/dom\.js -> src\/decoder\/decodeRoll\.js/);
});

test('a critical path over 350 KB fails', (t) => {
  const r = run(['--root', fixture(t, { [FONT]: Buffer.alloc(BUDGET_BYTES) })]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /over the 350\.0 KB budget/);
});

test('a critical path of exactly 350 KB passes and one byte more fails', (t) => {
  const root = fixture(t);
  const rest = ['index.html', 'styles.css', 'js/app.js'].reduce((n, rel) => n + statSync(join(root, rel)).size, 0);
  writeFileSync(join(root, FONT), Buffer.alloc(BUDGET_BYTES - rest));
  assert.equal(run(['--root', root]).status, 0);
  writeFileSync(join(root, FONT), Buffer.alloc(BUDGET_BYTES - rest + 1));
  assert.equal(run(['--root', root]).status, 1);
});

test('a shell file missing from the precache list fails', (t) => {
  for (const missing of ['index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'src/ui/dom.js', FONT]) {
    const root = fixture(t);
    const sw = 'const PRECACHE = ' + JSON.stringify(
      ['index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/picker.js', 'src/ui/dom.js', FONT]
        .filter((f) => f !== missing),
    ) + ';\n';
    writeFileSync(join(root, 'sw.js'), sw);
    const r = run(['--root', root]);
    assert.equal(r.status, 1, missing);
    assert.ok(r.stderr.includes('sw.js PRECACHE lacks ' + missing), r.stderr);
  }
});

test('staticImports skips import() and commented-out imports, and reads multi-line ones', () => {
  const src = [
    "import { a,",
    "  b } from './a.js';",
    "import './side.js';",
    'import x from "./x.js"; export * from \'./re.js\';',
    "export { y } from './y.js';",
    "// import { gone } from './comment.js';",
    "/* import z from './block.js'; */",
    "const url = 'https://example.org/'; import w from './w.js';",
    "const later = () => import('./dynamic.js');",
    "const meta = import.meta.url;",
    "export const notAnImport = 'from';",
  ].join('\n');
  assert.deepEqual(staticImports(src), ['./a.js', './side.js', './x.js', './re.js', './y.js', './w.js']);
});

test('parsePrecache reads string entries past comments', () => {
  const sw = 'const PRECACHE = [\n  "a.js", // trailing ] comment\n  /* ] */ "b.js",\n];\nconst X = ["z"];';
  assert.deepEqual(parsePrecache(sw), ['a.js', 'b.js']);
  assert.equal(parsePrecache('const OTHER = [];'), null);
});
