// CI runs the real suite (issue #113): .github/workflows/ci.yml installs
// dependencies on Node 20 and runs `npm test`, the seeded placeholder workflow
// is gone, and the `test` script is node's test runner. Run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');

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
  const install = ci.search(/run:\s*npm (ci|install)\b/);
  const npmTest = ci.search(/run:\s*npm test\s*$/m);
  assert.ok(install >= 0, 'no dependency install step');
  assert.ok(npmTest >= 0, 'no `npm test` step');
  assert.ok(install < npmTest, 'dependencies must be installed before `npm test`');
});

test('the placeholder never-stop-baseline workflow is deleted', () => {
  assert.equal(existsSync(join(WORKFLOWS, 'never-stop-baseline.yml')), false);
});

test('npm test is the node test runner', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts?.test ?? '', /^node --test\b/);
});
