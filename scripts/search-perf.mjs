// Usage: node scripts/search-perf.mjs
//
// Times src/search/voterSearch.js in headless Chrome under 4x CPU throttling
// (DevTools Emulation.setCPUThrottlingRate) over a deterministic synthetic
// roll of 10,000 voters (scripts/search-perf-stats.mjs, fixed seed; no
// downloaded data). The repo root is served by a tiny static server on
// 127.0.0.1, the page imports the module, builds the index once and times
// every searchVoters call with performance.now(); the first 10 queries are
// warm-up and are discarded. Writes reports/search-perf.md and prints
//   {"rollSize":10000,"queries":<n>,"p50":<ms>,"p95":<ms>,"max":<ms>}
// on stdout. Exits non-zero when p95 is 200 ms or more, or when the browser
// run fails. Needs puppeteer and its Chrome (see
// .github/workflows/search-perf.yml).

import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer';

import { WARDS, makeQueries, makeRoll, ms, percentile, renderReport } from './search-perf-stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'reports/search-perf.md');
const ROLL_SIZE = 10000;
const SEED = 136;
const THROTTLE = 4;
const WARMUP = 10;
const THRESHOLD_MS = 200;

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
// Cross-origin isolation gives the page a finer performance.now() clock.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const BLANK = '<!doctype html><meta charset="utf-8"><title>search perf</title>';

// Serves files under ROOT only; "/" is a blank page to import modules from.
function serve(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...ISOLATION });
    res.end(BLANK);
    return;
  }
  const file = normalize(join(ROOT, path));
  let ok = file.startsWith(ROOT + sep);
  try {
    ok = ok && statSync(file).isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    res.writeHead(404, ISOLATION);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...ISOLATION });
  createReadStream(file).pipe(res);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const roll = makeRoll(SEED, ROLL_SIZE);
const queries = makeQueries(roll, SEED);

const server = createServer(serve);
let browser;
let run;
try {
  const port = await listen(server);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  run = await page.evaluate(
    async ({ roll, queries, warmup }) => {
      const { buildSearchIndex, searchVoters } = await import('/src/search/voterSearch.js');
      const t0 = performance.now();
      const index = buildSearchIndex(roll);
      const buildMs = performance.now() - t0;
      const timed = [];
      queries.forEach(({ kind, q }, i) => {
        const start = performance.now();
        const results = searchVoters(index, q);
        const elapsed = performance.now() - start;
        if (i >= warmup) timed.push({ kind, ms: elapsed, hits: results.length });
      });
      return { buildMs, timed };
    },
    { roll, queries, warmup: WARMUP },
  );
  run.browser = await browser.version();
  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join('; ')}`);
} catch (err) {
  console.error(`search-perf: the headless Chrome run failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (!run) process.exit(1);

const samples = run.timed.map((t) => t.ms);
const byKind = {};
for (const t of run.timed) (byKind[t.kind] ||= []).push(t.ms);
const result = {
  browser: run.browser,
  rollSize: roll.length,
  wards: WARDS,
  seed: SEED,
  throttle: THROTTLE,
  warmup: WARMUP,
  queries: samples.length,
  p50: percentile(samples, 50),
  p95: percentile(samples, 95),
  max: Math.max(...samples),
  buildMs: run.buildMs,
  empty: run.timed.filter((t) => t.hits === 0).length,
  byKind: Object.fromEntries(
    Object.entries(byKind).map(([kind, kindMs]) => [kind, { count: kindMs.length, p95: percentile(kindMs, 95) }]),
  ),
  threshold: THRESHOLD_MS,
};
result.pass = result.p95 < THRESHOLD_MS;

mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, renderReport(result));

const round = (v) => Math.round(v * 100) / 100;
console.log(JSON.stringify({
  rollSize: result.rollSize,
  queries: result.queries,
  p50: round(result.p50),
  p95: round(result.p95),
  max: round(result.max),
}));
if (!result.pass) {
  console.error(`search-perf: p95 ${ms(result.p95)} is not under ${ms(THRESHOLD_MS)}; see ${REPORT}`);
  process.exit(1);
}
if (result.empty === result.queries) {
  console.error(`search-perf: no timed query returned a result, so nothing was measured; see ${REPORT}`);
  process.exit(1);
}
