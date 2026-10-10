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
| binding | `SYNC_DB` (a D1 database bound to the Pages project under this variable name, with `migrations/0001_sync.sql` and `migrations/0002_sync_guards.sql` applied in that order) | `functions/sync.js` (also reached through `functions/sync/[[path]].js`) | Every `/sync/*` request answers 503. Without the migrations applied, every join, push and pull fails. Binding a different or empty database drops every team's stored records and passphrase verifiers. |
| plan | Cloudflare Workers Paid (or equal) on the account that owns the Pages project | `functions/sync.js` (D1 reads and writes on every push and pull) and every Function request | On the free plan, D1 rows read and written are capped per day and Function requests are capped per day. Once a cap is hit on polling day, push and pull fail until the daily reset, and teammates' marks stop arriving. |
| local only | `PORT`, `HOST` (`process.env`) | `relay/server.mjs` | Not used on Cloudflare. For a self-hosted Node relay they default to `8080` and `127.0.0.1`, so without them the server only listens on localhost. |

`relay/rollRelay.mjs` reads no environment variable. Its allowlist comes from
`config/constituency.json`, which is deployed with the site.

## Sync access: lost devices, replayed joins and join lockouts

Run these against the D1 database bound as `SYNC_DB`, for example with
`wrangler d1 execute <database> --remote --command "..."`.

- **A lost or stolen device.** Its token never expires. Withdraw that one
  device with
  `INSERT OR IGNORE INTO revoked_devices VALUES ('<candidateId>', '<deviceId>')`.
  Its pushes and pulls then get 401, and its teammates are unaffected. The
  device id is in `records.device_id` for anything the device pushed.
  Rotating `SYNC_SECRET` also withdraws it, but signs out every device of
  every team.
- **A replayed join.** The join request carries a fixed passphrase verifier
  and no server challenge. Anyone who captures one join request can resend it
  and get a fresh device token for that team, and the team must then be
  treated as compromised. Revoking device ids only removes tokens already
  issued; a resent join mints a new one. Until joins are bound to a
  single-use server nonce (a protocol change that needs a matching client
  update), the only full fix is to move the team to a new candidate code with
  a new passphrase.
- **A locked-out team.** After ten wrong passphrases for one candidate code,
  that code's joins answer 429 for fifteen minutes. Devices that have already
  joined keep syncing. Anyone who knows the candidate code can keep the lock
  in place with ten wrong guesses every fifteen minutes. That blocks new
  teammates from joining, for example on polling day. Lift the lock at once
  with `DELETE FROM join_failures WHERE candidate_id = '<candidateId>'`; it
  returns as soon as the guessing does.

## What is not here

- The team SMS number. It is a per-team setting that the coordinator types on
  the phone. It is stored encrypted and synced as the team record
  `team:smsNumber`. It is never part of `config/constituency.json`, which
  every visitor can read, and it is not an operator setting.
- Activation codes. No code reads them yet. When a function starts reading
  one, its `env.<NAME>` goes into the table above, and `npm test` fails until
  it does.
