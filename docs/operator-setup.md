# Operator setup

This is the inventory of everything the deployed app needs from the platform
that the repository cannot provide itself. The operator issues for secrets,
bindings, DNS and plan upgrades (#116 to #118) take their exact names from
this table, so nobody has to guess a binding or secret name.

Only names appear here. A secret value never goes in this file, in the
repository, in an issue or in `config/constituency.json`.

The sources are every `env.<NAME>` read in `functions/roll.js`,
`functions/sync.js` and `functions/sync/[[path]].js`, every `process.env`
read in `relay/server.mjs` and `relay/rollRelay.mjs`, and `_routes.json`.
`test/operatorSetup.test.js` (run by `npm test`) fails if a name read under
`functions/` or `relay/` is missing from this file.

## Inventory

| Kind | Exact name | Read by | What breaks without it |
| --- | --- | --- | --- |
| DNS | `canvass.takshavid.com`: a CNAME record at Porkbun pointing to the Cloudflare Pages project's `*.pages.dev` host, and added as a custom domain on that project | the browser, and the Pages project's custom-domain setting | The app is not reachable at the candidate's domain. If the name points at a static-only host (for example GitHub Pages), the shell loads, but `/roll` and `/sync/*` have no function behind them, so every roll download fails with the Hindi retry message and sync never connects. |
| hosting | Cloudflare Pages project, serving the repository root as the static site and deploying on every push to `main` | the whole site; `functions/` becomes Pages Functions | Nothing is served. With a static-only host instead, the same failures as the DNS row. |
| hosting | `_routes.json` (`include`: `/roll`, `/sync/*`) | Cloudflare Pages routing | Without it, every request (shell, fonts, service worker) runs through Functions and counts against the request quota. If `/roll` or `/sync/*` is left out, that path is served as a static file and answers 404. |
| binding | `ASSETS` (the Pages static-asset binding; Pages provides it, the operator creates nothing) | `functions/roll.js` | `functions/roll.js` cannot read `config/constituency.json`, so `/roll` answers 503 `relay not ready` and no roll downloads. |
| secret | `SYNC_SECRET` (an encrypted environment variable on the Pages project) | `functions/sync.js` (also reached through `functions/sync/[[path]].js`) | Every `/sync/*` request answers 503, so teams cannot join, push or pull. Changing it signs every device out: each device's token stops verifying (401) until it joins again. |
| binding | `SYNC_DB` (a D1 database binding on the Pages project under this variable name, with the tables from `migrations/0001_sync.sql` applied; see "D1 sync database" below) | `functions/sync.js` (also reached through `functions/sync/[[path]].js`) | Every `/sync/*` request answers 503. Binding a different or empty database drops every team's stored records and passphrase verifiers; a database without the migration applied fails every join, push and pull. |
| plan | Cloudflare Workers Paid (or equal) on the account that owns the Pages project | `functions/sync.js` (D1 reads and writes on every push and pull) and every Function request | On the free plan, D1 rows read and written are capped per day and Function requests are capped per day. Once a cap is hit on polling day, push and pull fail until the daily reset, and teammates' marks stop arriving. |
| local only | `PORT`, `HOST` (`process.env`) | `relay/server.mjs` | Not used on Cloudflare. For a self-hosted Node relay they default to `8080` and `127.0.0.1`, so without them the server only listens on localhost. |

`relay/rollRelay.mjs` reads no environment variable. Its allowlist comes from
`config/constituency.json`, which is deployed with the site.

## D1 sync database (`SYNC_DB`)

`functions/sync.js` keeps every team's records, counters, seen-voting marks
and passphrase verifiers in one D1 database, read through the `SYNC_DB`
binding.

Current state (operator note on #183, 2026-10-10):

- Database `panchayat-ward-canvass-sync`, location hint Asia Pacific, on the
  account's free plan. Its ID is shown on the database's page in the
  Cloudflare dashboard.
- Schema: the four tables from `migrations/0001_sync.sql` (`records`,
  `counters`, `marks`, `verifiers`), applied through the D1 console and
  checked against `sqlite_master`.
- Binding: `SYNC_DB` on the Pages project's Production environment, next to
  `SYNC_SECRET`. No function reads a KV namespace any more. The old sync KV
  binding is not required. It can be removed once the one-time copy below has
  been run (see "One-time KV-to-D1 migration").
- Preview has no `SYNC_DB` yet, so `/sync/*` on preview deployments answers
  503.
- Production was redeployed at `main d8a48d4` and checked live on
  `canvass.takshavid.com`: join 200, push accepted (cursor 1), pull returned
  the pushed record, a wrong passphrase got 401.

No operator issue is open for this: the Production database exists and is
bound. The step below is the reference for setting it up again (a new
account, or the Preview environment).

### Operator step: create, migrate and bind the D1 database

1. Create the D1 database:

   ```sh
   npx wrangler d1 create panchayat-ward-canvass-sync --location apac
   ```

   (or Workers & Pages > D1 > Create database in the dashboard, with the same
   name and the Asia Pacific location hint).

2. Apply `migrations/0001_sync.sql` to it, from the repository root:

   ```sh
   npx wrangler d1 execute panchayat-ward-canvass-sync --remote --file=migrations/0001_sync.sql
   ```

   Then check that the four tables exist:

   ```sh
   npx wrangler d1 execute panchayat-ward-canvass-sync --remote --command "SELECT name FROM sqlite_master WHERE type = 'table'"
   ```

   The output lists `records`, `counters`, `marks` and `verifiers`. The
   migration only uses `CREATE TABLE IF NOT EXISTS`, so running it again on
   a database that already has the tables changes nothing.

3. Bind it to the Pages project as `SYNC_DB`: Pages project > Settings >
   Bindings > Add > D1 database, variable name `SYNC_DB`, database
   `panchayat-ward-canvass-sync`. Do this for every environment that should
   serve `/sync/*` (Production, and Preview if wanted), then redeploy, since a
   binding only reaches deployments made after it is saved.

### One-time KV-to-D1 migration

Before D1, `functions/sync.js` kept the same data in a Workers KV namespace
bound as `SYNC_KV`. `scripts/migrate-kv-to-d1.mjs` copies it into D1 once:
`c/<candidate>/verifier` to `verifiers`, `c/<candidate>/seq` to `counters`,
every `c/<candidate>/r/<seq>` to a `records` row with the same seq and
fields, and every `c/<candidate>/m/<id>` to a `marks` row. Run it from the
repository root, logged in to the account with `npx wrangler login`:

1. Export the namespace. Its ID is on the namespace's page under Workers &
   Pages > KV:

   ```sh
   node scripts/migrate-kv-to-d1.mjs export --namespace-id <namespace-id> > kv-dump.json
   ```

2. Export the records D1 already holds (teams have pushed to D1 since the
   cutover), so a seq that both stores used is caught:

   ```sh
   npx wrangler d1 execute panchayat-ward-canvass-sync --remote --json --command "SELECT candidate_id, seq, id, ciphertext FROM records" > d1-records.json
   ```

3. Turn the dump into SQL:

   ```sh
   node scripts/migrate-kv-to-d1.mjs sql kv-dump.json --d1-records d1-records.json > kv-to-d1.sql
   ```

   It prints how many verifiers, counters, records and marks it found, and
   any key it skipped with the reason. If a KV record's seq is already
   taken in D1 by a different record, it lists each such `collision` and
   writes no SQL. Those records cannot keep their seq, so stop and raise it
   on #184 rather than applying anything.

4. Apply it:

   ```sh
   npx wrangler d1 execute panchayat-ward-canvass-sync --remote --file=kv-to-d1.sql
   ```

The SQL can safely be run again, for example after a timeout or with a fresh
export. Verifiers, records and marks are inserted only where missing, so a
second run adds nothing and never replaces a verifier a team already has in
D1. A counter only moves up, to the highest of its D1 value, the KV counter
and the highest migrated record seq, so new pushes never reuse a migrated
slot.

When the KV binding can be removed: once step 4 has succeeded, check the
result. Running steps 1 to 4 again must change nothing. `SELECT COUNT(*) FROM
records` must be at least the number of `r/` keys in `kv-dump.json`. After that,
delete the `SYNC_KV` binding (Pages project > Settings > Bindings) and
redeploy. No function reads it. Keep the namespace itself until polling day
is over as a backup, then delete it. Delete `kv-dump.json`, `d1-records.json`
and `kv-to-d1.sql` too. They hold every team's ciphertext and verifier.

## What is not here

- The team SMS number. It is a per-team setting that the coordinator types on
  the phone. It is stored encrypted and synced as the team record
  `team:smsNumber`. It is never part of `config/constituency.json`, which
  every visitor can read, and it is not an operator setting.
- Activation codes. No code reads them yet. When a function starts reading
  one, its `env.<NAME>` goes into the table above, and `npm test` fails until
  it does.
