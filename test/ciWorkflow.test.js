// CI runs the real suite (issue #113): .github/workflows/ci.yml installs
// dependencies on Node 20 and runs `npm test`, the seeded placeholder workflow
// is gone, and the `test` script discovers every *.test.js / *.test.mjs under
// test/, src/ and scripts/ and fails when any of them fails. Run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('ci.yml runs on push and pull_request on ubuntu-latest', () => {
  assert.match(ci, /^on:\s*$/m);
  assert.match(ci, /^\s+push:/m);
  assert.match(ci, /^\s+pull_request:/m);
  assert.match(ci, /runs-on:\s*ubuntu-latest/);
});

test('ci.yml sets up Node 20, installs dependencies, then runs npm test', () => {
  assert.match(ci, /uses:\s*actions\/checkout@v4/);
  assert.match(ci, /uses:\s*actions\/setup-node@v4/);
  assert.match(ci, /node-version:\s*['"]?20['"]?\s*$/m);
  const install = ci.search(/run:\s*npm ci\b/);
  const npmTest = ci.search(/run:\s*npm test\s*$/m);
  assert.ok(install >= 0, 'no `npm ci` step');
  assert.ok(npmTest >= 0, 'no `npm test` step');
  assert.ok(install < npmTest, 'dependencies must be installed before `npm test`');
  assert.ok(existsSync(join(ROOT, 'package-lock.json')), '`npm ci` needs a committed package-lock.json');
});

test('the placeholder never-stop-baseline workflow is deleted', () => {
  assert.equal(existsSync(join(WORKFLOWS, 'never-stop-baseline.yml')), false);
});

// Bare `node --test` discovers every test file; adding paths would narrow it
// (e.g. `node --test test/` drops src/ and scripts/).
test('npm test is bare node --test discovery', () => {
  assert.equal(pkg.scripts?.test, 'node --test');
});

// Runs the script's runner in a scratch project holding the given files and
// returns its exit status. NODE_TEST_CONTEXT is dropped so the child reports
// on its own instead of to this runner.
function runIn(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-npm-test-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const [cmd, ...args] = pkg.scripts.test.split(/\s+/);
    assert.equal(cmd, 'node');
    return spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PASS = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const FAIL = "import { test } from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n";
const PATHS = [
  'test/a.test.js',
  'test/a.test.mjs',
  'src/decoder/a.test.js',
  'src/decoder/a.test.mjs',
  'scripts/a.test.js',
  'scripts/a.test.mjs',
];

test('npm test exits zero when every discovered test passes', () => {
  assert.equal(runIn(Object.fromEntries(PATHS.map((p) => [p, PASS]))), 0);
});

for (const failing of PATHS) {
  test(`npm test runs ${failing} and exits non-zero when it fails`, () => {
    const files = Object.fromEntries(PATHS.map((p) => [p, p === failing ? FAIL : PASS]));
    assert.notEqual(runIn(files), 0);
  });
}
