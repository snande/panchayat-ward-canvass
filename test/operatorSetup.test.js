// docs/operator-setup.md is the one inventory of what the deployed app needs
// from the platform (issue #115). Every `env.<NAME>` read under functions/
// (and every process.env read under relay/) must be named in it, so a new
// secret or binding cannot ship without an operator row. README keeps no
// setup steps of its own, only links to the document. Run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC_PATH = 'docs/operator-setup.md';
const doc = readFileSync(join(ROOT, DOC_PATH), 'utf8');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// The same reads as `grep -rnoE "env\.[A-Z_a-z0-9]+" functions relay`.
function envReads(dir) {
  const reads = new Map();
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [, name] of text.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!reads.has(name)) reads.set(name, new Set());
      reads.get(name).add(file);
    }
  }
  return reads;
}

function tableRows() {
  return doc
    .split('\n')
    .filter((line) => /^\|/.test(line) && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

test('the scan finds the env reads the functions are known to make', () => {
  const names = [...envReads('functions').keys()];
  for (const known of ['ASSETS', 'SYNC_SECRET', 'SYNC_DB']) {
    assert.ok(names.includes(known), `scan missed env.${known}`);
  }
});

test('every env.<NAME> read under functions/ and relay/ is named in the document', () => {
  const missing = [];
  for (const dir of ['functions', 'relay']) {
    for (const [name, files] of envReads(dir)) {
      if (!doc.includes(`\`${name}\``)) missing.push(`${name} (read in ${[...files].join(', ')})`);
    }
  }
  assert.deepEqual(missing, [], `${DOC_PATH} does not name: ${missing.join('; ')}`);
});

test('the inventory table has kind, name, reader and impact columns', () => {
  const header = doc.split('\n').find((line) => /^\|/.test(line));
  assert.ok(header, `${DOC_PATH} has no table`);
  assert.match(header, /\|\s*Kind\s*\|\s*Exact name\s*\|\s*Read by\s*\|\s*What breaks without it\s*\|/);
  const rows = tableRows();
  for (const row of rows) assert.equal(row.length, 4, `row has ${row.length} cells: ${row.join(' | ')}`);
  const kinds = new Set(rows.map(([kind]) => kind));
  for (const kind of ['DNS', 'hosting', 'secret', 'binding', 'plan']) {
    assert.ok(kinds.has(kind), `no ${kind} row`);
  }
});

test('the custom domain has exactly one DNS row', () => {
  const rows = tableRows().filter(([kind, name]) => kind === 'DNS' && name.includes('canvass.takshavid.com'));
  assert.equal(rows.length, 1);
});

test('_routes.json and every path it routes to functions are in the document', () => {
  const routes = JSON.parse(readFileSync(join(ROOT, '_routes.json'), 'utf8'));
  assert.ok(doc.includes('`_routes.json`'));
  for (const path of routes.include) assert.ok(doc.includes(`\`${path}\``), `${path} not named`);
});

test('every source file the issue names is cited', () => {
  for (const file of [
    'functions/roll.js',
    'functions/sync.js',
    'functions/sync/[[path]].js',
    'relay/server.mjs',
    'relay/rollRelay.mjs',
  ]) {
    assert.ok(doc.includes(`\`${file}\``), `${file} not cited`);
  }
});

test('the document holds names only, no secret-looking value', () => {
  assert.doesNotMatch(doc, /[A-Za-z0-9+/=_-]{32,}/, 'long token-like string');
  assert.doesNotMatch(doc, /\b(SYNC_SECRET|SECRET|TOKEN|KEY)\s*[:=]\s*\S/, 'name followed by a value');
  assert.doesNotMatch(doc, /\+?\d[\d -]{9,}\d/, 'phone-number-like digits');
});

test('README links to the document and keeps no setup steps', () => {
  assert.ok(readme.includes(`(${DOC_PATH})`), `README does not link to ${DOC_PATH}`);
  for (const step of [
    /operator must (bind|create|add|set)/i,
    /\b(create|add) (a |the )?(KV namespace|secret|binding|CNAME|DNS record)/i,
    /CNAME at the registrar/i,
    /\bupgrade (to|the) (a )?(paid|Workers Paid)/i,
    /wrangler (secret|kv)/i,
  ]) {
    assert.doesNotMatch(readme, step);
  }
});

test('config/constituency.json holds no secret or phone number', () => {
  const config = readFileSync(join(ROOT, 'config/constituency.json'), 'utf8');
  assert.doesNotMatch(config, /"(teamSmsNumber|smsNumber|phone|mobile|secret|token)"\s*:/i);
  assert.doesNotMatch(config, /\+91|\b\d{10,}\b/);
  for (const name of envReads('functions').keys()) assert.ok(!config.includes(name), `${name} in config`);
});
