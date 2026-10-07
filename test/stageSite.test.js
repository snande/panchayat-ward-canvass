// The Cloudflare Pages staging step (scripts/stage-site.mjs): publishes the
// shell, not the relay or fixtures, and covers every sw.js precache path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { precachePaths, stageSite } from '../scripts/stage-site.mjs';

test('staged site has every precached path and none of the server-side files', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'stage-')), 'dist');
  try {
    stageSite(out);
    const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
    for (const p of precachePaths(sw)) {
      if (p !== './') assert.ok(existsSync(join(out, p)), `${p} staged`);
    }
    assert.ok(existsSync(join(out, '_routes.json')));
    assert.ok(existsSync(join(out, 'src/decoder/decodeRoll.js')));
    for (const gone of ['relay', 'fixtures', 'functions', 'test', 'scripts', 'src/decoder/glyphMap.test.js']) {
      assert.equal(existsSync(join(out, gone)), false, `${gone} not staged`);
    }
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});
