// Simulates one team's polling day against the sync Function (issue #182)
// and checks that five such teams stay under half the Workers Free daily
// limits:
//
//   node scripts/sync-poll-sim.mjs [--phones 20] [--hours 8] [--interval-ms N] [--seed 1]
//
// Every request goes through the real onRequest from functions/sync.js, with
// env.SYNC_DB a local D1 stand-in carrying migrations/0001_sync.sql. Miniflare
// cannot be installed here (no network for npm), so the backend is
// test/helpers/memoryD1.js, and the output says so. Rows read and written are
// summed from that shim's D1 counters (meta.rows_read / meta.rows_written,
// totalled in db.usage), not estimated here.
//
// The day: each phone joins the team, syncs once at startup, then every
// SYNC_INTERVAL_MS (src/sync/syncEngine.js) for the whole visible day, as the
// engine's timer does. A sync pushes only when the phone saved something
// since the last one, then pulls, following `more`. Phones save on average one
// record every SAVE_EVERY_MINUTES; most are seen-voting marks for a voter
// drawn from the whole ward, so teammates sometimes mark the same voter, and
// the rest are the phone's own contact edits. Teams never share rows, so five
// teams cost five times one team.
//
// Exits 1 when any five-team total is not below its limit.

import { pathToFileURL } from 'node:url';

import { onRequest } from '../functions/sync.js';
import { SYNC_INTERVAL_MS } from '../src/sync/syncEngine.js';
import { createSyncD1 } from '../test/helpers/memoryD1.js';

// Half the Workers Free daily limits: 100 000 requests, 5 000 000 rows read
// and 100 000 rows written.
export const LIMITS = { requests: 50000, rowsRead: 2500000, rowsWritten: 50000 };
export const TEAMS = 5;
export const SAVE_EVERY_MINUTES = 4;
const MARK_SHARE = 0.75;
const WARD_VOTERS = 2000;
const CONTACTS_PER_PHONE = 40;

const ORIGIN = 'https://canvass.example';
const SECRET = 'sync-poll-sim-secret';

// mulberry32: a small seeded generator, so every run is the same day.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rand, mean) {
  const limit = Math.exp(-mean);
  let k = 0;
  for (let p = rand(); p > limit; p *= rand()) k += 1;
  return k;
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

export async function simulate({ phones = 20, hours = 8, intervalMs = SYNC_INTERVAL_MS, seed = 1 } = {}) {
  const db = await createSyncD1();
  const env = { SYNC_SECRET: SECRET, SYNC_DB: db };
  const rand = random(seed);
  let requests = 0;

  async function call(path, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    requests += 1;
    const res = await onRequest({
      request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
    });
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
    return res.json();
  }

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const devices = [];
  for (let i = 0; i < phones; i += 1) {
    const { token } = await call('/sync/join', { method: 'POST', body: { candidateId: 'team1', verifier } });
    devices.push({ index: i, token, cursor: 0, outbox: new Map() });
  }

  const ciphertext = () => base64url(crypto.getRandomValues(new Uint8Array(48)));
  let clock = Date.UTC(2026, 9, 10, 8);

  function save(device) {
    const id = rand() < MARK_SHARE
      ? `mark:w1:${1 + Math.floor(rand() * WARD_VOTERS)}`
      : `contact:p${device.index}:${1 + Math.floor(rand() * CONTACTS_PER_PHONE)}`;
    clock += 1;
    device.outbox.set(id, { id, updatedAt: clock, ciphertext: ciphertext(), iv: base64url(crypto.getRandomValues(new Uint8Array(12))) });
  }

  async function sync(device) {
    if (device.outbox.size > 0) {
      await call('/sync/push', { method: 'POST', token: device.token, body: { records: [...device.outbox.values()] } });
      device.outbox.clear();
    }
    for (;;) {
      const page = await call(`/sync/pull?since=${device.cursor}`, { token: device.token });
      device.cursor = page.cursor;
      if (!page.more) break;
    }
  }

  for (const device of devices) await sync(device);
  const ticks = Math.floor((hours * 3600000) / intervalMs);
  const savesPerTick = intervalMs / 60000 / SAVE_EVERY_MINUTES;
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const device of devices) {
      for (let n = poisson(rand, savesPerTick); n > 0; n -= 1) save(device);
    }
    for (const device of devices) await sync(device);
  }

  const team = { requests, rowsRead: db.usage.rowsRead, rowsWritten: db.usage.rowsWritten };
  const fiveTeams = Object.fromEntries(Object.entries(team).map(([key, value]) => [key, value * TEAMS]));
  return { backend: `memoryD1 (${db.engine})`, phones, hours, intervalMs, team, fiveTeams };
}

// The names of the five-team totals that are not below their limit.
export const overLimits = (totals) => Object.keys(LIMITS).filter((key) => !(totals[key] < LIMITS[key]));

const LABELS = { requests: 'Function requests', rowsRead: 'Rows read', rowsWritten: 'Rows written' };

export function report(result) {
  const lines = [
    `Backend: ${result.backend}`,
    `One team, ${result.phones} phones, ${result.hours} h, syncing every ${result.intervalMs / 1000} s:`,
    ...Object.keys(LABELS).map((key) => `  ${LABELS[key]}: ${result.team[key]}`),
    `${TEAMS} teams (limit is half the Workers Free daily limit):`,
    ...Object.keys(LABELS).map((key) => {
      const ok = result.fiveTeams[key] < LIMITS[key];
      return `  ${LABELS[key]}: ${result.fiveTeams[key]} / ${LIMITS[key]} ${ok ? 'ok' : 'OVER'}`;
    }),
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const names = { '--phones': 'phones', '--hours': 'hours', '--interval-ms': 'intervalMs', '--seed': 'seed' };
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    const value = Number(argv[i + 1]);
    if (!name || !(value > 0)) throw new Error(`usage: sync-poll-sim.mjs [${Object.keys(names).map((n) => `${n} N`).join('] [')}]`);
    options[name] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await simulate(parseArgs(process.argv.slice(2)));
  console.log(report(result));
  const over = overLimits(result.fiveTeams);
  if (over.length > 0) {
    console.error(`Over the limit: ${over.map((key) => LABELS[key]).join(', ')}`);
    process.exitCode = 1;
  }
}
