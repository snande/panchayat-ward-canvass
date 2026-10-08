# panchayat-ward-canvass

## Ward roll: download, decode, encrypted offline copy

Picking a ward in the picker loads that ward's voter roll. There is no upload
path and no file-input element; `test/noFileUpload.test.js` scans the repo for
one.

1. `src/roll/fetchRoll.js` downloads the PDF for the selection's `pdfUrl`.
   The transport is `ROLL_TRANSPORT`, which must equal the verdict line at the
   end of `docs/research/sec-roll-source.md` (a test pins it). The verdict is
   `relay-required` (the SEC server sends no CORS header), so the browser
   requests the same-origin `/roll?url=<encoded pdfUrl>`.
2. `decodeRoll` from `src/decoder/` turns the bytes into entries on the text
   layer. The decoder and its glyph table are imported only when a PDF has to
   be decoded.
3. `src/roll/rollStore.js` keeps only `serial, name, relative, age, gender,
   house` of each live entry. Struck-off (deleted) entries, EPIC numbers and
   the PDF are never stored. The entries are encrypted with WebCrypto AES-GCM
   (256-bit, fresh 12-byte IV per write, ward key as additional data) and
   written to IndexedDB (`ward-canvass`). The key is generated on the device
   as a non-extractable `CryptoKey` and kept in the same database.
   Struck-off serials are left out because the benchmark roll
   (`fixtures/badli-ward1-expected.json`, 297 voters) does not list them.
4. `src/ui/rollList.js` renders the entries as a virtualised list: fixed
   100 px rows, with only the rows in view (plus 6 above and below) in the
   DOM. Text uses the page's Noto Sans Devanagari font.

`src/roll/rollFlow.js` ties these together. Picking a ward that is already
stored shows the encrypted copy without a request. At startup the last stored
ward is shown again, so the app opens offline once a roll has been fetched.
A failed download shows a Hindi message with a retry button.

### Roll relay

`relay/rollRelay.mjs` is a fetch-style handler for `GET /roll?url=...`:

- It fetches only URLs listed as a ward `pdfUrl` in
  `config/constituency.json`. Any other URL, or a missing or repeated `url`,
  answers 403 without contacting any server. Other methods answer 405.
- The upstream body is read with a running byte count and cut off at 20 MB,
  so a response with no Content-Length cannot exhaust memory.
- The whole upstream exchange (headers and body) is bounded by a 30 s timer;
  a stalled source answers 502 instead of holding the request open.
- An upstream error, redirect (the portal answers 302 for a missing ward),
  non-PDF or oversized body answers 502.
- It sends no CORS header, so only pages on its own origin can read it.

`relay/server.mjs` serves the shell's static files and the relay from one
origin. It serves only the shell's files and directories, never `fixtures/`.

```
PORT=8080 HOST=0.0.0.0 node relay/server.mjs
curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8080/roll?url=https://example.com/x.pdf'   # 403
```

The domain in `CNAME` must be served by this server (or the handler mounted
at `/roll` on the same host), not by a static-only host. A static-only host
has no relay, so every download fails with the Hindi retry message.

The live deployment is Cloudflare Pages: the repository root is the static
site, and `functions/roll.js` mounts the same `createRollRelay` handler on
`/roll` as a Pages Function, reading `config/constituency.json` through the
static-asset binding on first use. `_routes.json` routes only `/roll` and
`/sync/*` to functions, so every other URL stays a plain static file. The custom domain is
a CNAME at the registrar to the Pages project. That deployment, and the
Android Chrome check that Badli ward 1 loads, scrolls smoothly and reads as
correct Hindi, are operator steps outside repo-ci.

## Team sync endpoints

`functions/sync.js` is a Pages Function for syncing a candidate's team
devices. `functions/sync/[[path]].js` re-exports it so that every `/sync/*`
path reaches it:

- `POST /sync/push` with body `{records: [{id, updatedAt, ciphertext, iv}]}`
  returns `{accepted, cursor}`.
- `GET /sync/pull?since=<cursor>` returns the caller's team records with a
  server sequence above `cursor`, as `{records, cursor, more}`.

Every request needs `Authorization: Bearer <token>`. The token is
`base64url("<candidateId>.<deviceId>")` + `.` + base64url of an HMAC-SHA-256
over `<candidateId>:<deviceId>`, keyed with the `SYNC_SECRET` secret.
`signSyncToken` in the same file mints one. A missing or invalid token gets a
bare 401. The candidate comes only from the verified token, never from the
request. Records are stored under `c/<candidateId>/r/<seq>`, with the counter
at `c/<candidateId>/seq`, in the KV namespace bound as `SYNC_KV`. The server
stores `ciphertext` as given and never decrypts it.

The pull cursor only advances through an unbroken run of sequence numbers. If
a later record is visible before an earlier one, for example because two
pushes overlapped, the pull stops at the gap. The client then picks up the
earlier record on its next pull instead of skipping it. A gap is skipped only
once the record after it was claimed more than five minutes ago, which means
the push that owned the gap has died.

The operator must bind `SYNC_SECRET` and `SYNC_KV` on the Pages project;
without them the endpoints return 503. That binding, and the endpoints
running against real Pages KV, are checked outside repo-ci. `test/sync.test.js`
exercises the function against an in-memory `SYNC_KV`.

## Search screen

`src/ui/searchScreen.js` is the on-phone voter search screen. It is plain DOM with no framework:

```js
import { mountSearchScreen } from './src/ui/searchScreen.js';

const screen = mountSearchScreen(document.body, voters); // voters: [{ id, serial, name, relativeName, houseNo }]
// screen.destroy() unmounts it
```

- Shows one Hindi input (`lang="hi"`, `inputmode="text"`, placeholder `नाम खोजें`). Each query is debounced by 100 ms, runs `search` from `src/search/hindiSearch.js`, and shows up to 50 results, with name, relative, serial and house number in each row.
- An exact full-name match is always listed first. When nothing matches, it shows `कोई मतदाता नहीं मिला`.
- Fully offline: it makes no network requests. The search index is kept in memory only and is never written to `localStorage`, `sessionStorage` or `indexedDB`.
- The roll flow (`src/roll/rollFlow.js`) mounts it above the ward's roll list through `src/ui/rollSearch.js`, so the box appears whenever a roll is on screen, including a roll restored offline at startup. While the box holds a query, the results replace the full list. Clearing the box brings the list back.

Tests in `test/searchScreen.test.js` run with `npm test` (and in CI) against a small in-process fake DOM (`test/helpers/fakeDom.js`), not jsdom or a browser, so no extra dependencies are needed. The timing bound and the `lang`/`inputmode` attributes are therefore verified in that test DOM environment, not on a real Android Chrome device.

## Tally by SMS

`src/tally/smsCodec.js` packs a worker's "seen voting" roll serials into SMS
messages of the form `PT1 <teamTag> <workerId> <serials> <checksum>`:

- The serials are base36, sorted, with no repeats, and joined by `.`. They are
  packed greedily so that each message has at most 160 plain ASCII (GSM-7)
  characters.
- The checksum is the first 4 hex digits of SHA-256 over the rest of the
  message.
- Each message stands alone, and it carries roll serials only: no names, phone
  numbers or EPIC numbers.
- `decodeTallySms(text, expectedTeamTag)` ignores the whitespace and line
  breaks that SMS apps add. It rejects a bad checksum, an unknown prefix, or
  another candidate's `teamTag` with `{ok:false, reason}`.

`src/ui/smsSendButton.js` renders the `एसएमएस से भेजें` button with
`renderSmsSendButton(container, {getSerials, config})`. `config` carries
`teamSmsNumber`, `teamTag` and `workerId`. Pressing the button sets
`location.href` to `sms:<teamSmsNumber>?body=<first message>`, which Android
Chrome hands to the default SMS app. When there are more parts, it shows a
"next part" button for each one. It makes no network request.

The team number is a per-team setting, and it is never part of
`config/constituency.json`, which every visitor can read. The coordinator
types it into the `टीम का एसएमएस नंबर` field on the SMS entry screen, in
international form with the country code (a bare 10-digit mobile number gets
`+91`). `src/team/teamSmsNumber.js` keeps it on the phone encrypted with the
device key and queues it for the team as the sync record `team:smsNumber`,
which the sync engine encrypts with the team key like contacts. Every
teammate's phone picks it up on its next sync while online, and the last save
on any phone wins. Until this phone holds a number, the button is disabled and
shows `tally.smsNumberMissing`.

## SMS tally in the ward roll

The `बिना इंटरनेट: एसएमएस से गिनती` button above the roll opens
`src/ui/smsTallyView.js` in the same place, for when there is no mobile data:

- The top panel counts this worker's seen-voting marks in the ward and sends
  them with the `एसएमएस से भेजें` button. The messages carry the team's
  `teamTag` (`teamTagFor(candidateId)` in `src/tally/smsCodec.js`: the
  candidate code, or a 16-digit hash of it when it is longer than an SMS id)
  and this phone's worker id.
- The panel below is the coordinator's paste form. A pasted SMS goes through
  the SMS inbox and then becomes a seen-voting mark for each serial
  (`src/tally/smsMarks.js`), in the name of the worker who sent it. Marks are
  keyed by ward and serial, so a voter who arrives by SMS from two phones, or
  by SMS and by sync, counts once. Serials that are not in the ward's roll are
  not counted, and the form says so. The ward's team count sits under the
  form, and the turnout screen shows the same figure.

Before polling day, the coordinator saves the team's SMS number in that form.
Workers' phones need one sync while online to receive it.

To check it: mark the same voter on two phones in airplane mode, send each
phone's marks by SMS and paste both on the coordinator's phone (the count goes
up by 1), then reconnect all three. The count stays the same on every phone.
`test/smsTallyWiring.test.js` does this with three in-memory phones and the
real `functions/sync.js` handler.

## Polling-day count beside official turnout

Tapping a voter in the ward roll opens their contact panel (or card) with a
`वोट डालते देखा` button under it (`src/ui/seenVotingMark.js`). Tapping it
saves a seen-voting mark through `src/tally/seenVotingStore.js`: kept on the
phone, encrypted, and queued for the team, so it works offline. A voter
already marked, on this phone or a teammate's, shows `वोट डाल दिया — दर्ज है।`
instead of the button, and this follows marks that arrive while the panel is
open. The mark is attributed to this phone's id in its team (`getDeviceId()`
in `src/sync/teamAuth.js`), or `device` before it has joined.

The `मतदान के दिन का हिसाब खोलें` button above the roll opens the turnout
screen (`src/ui/turnoutScreen.js`) in the same place. Its supporter count is
`wardCount(ward)`: the distinct voters of that ward marked by the team, as far
as this phone knows. A voter marked on two phones is one mark, on the phones
and on the server, so it counts once. The count is read again whenever marks
are added, including teammates' marks arriving with a sync, while the screen
is open.

To check it: mark the same voter on two phones in airplane mode, reconnect
both, and open the turnout screen on each; the voter adds 1, not 2.
`test/turnoutWiring.test.js` does this with two in-memory phones and the real
`functions/sync.js` handler.

## PWA shell

The installable Hindi shell is plain static files: `index.html`,
`manifest.webmanifest`, `sw.js`, `styles.css`, `js/`, `icons/`, `fonts/` and
`src/strings.hi.json`. It makes no requests to other origins, and the
precached assets, font included, must stay under 400 KB.

### Hindi strings

All user-visible shell text is in `src/strings.hi.json`, a flat key-to-Hindi
map:

- In `index.html`, each text element names its string with
  `data-i18n="<key>"`, and `<title>` uses `app_title`.
- At startup, `js/app.js` fetches the table (precached, so this works
  offline) and applies it.
- Each element also holds its table string as a fallback, so the page stays
  in Hindi if the table fails to load.
- Status lines have no element to hold a fallback, so `js/app.js` keeps
  copies of their strings in `FALLBACK_STRINGS`.
- `sw.js` keeps copies of `offline_title` and `offline_body` for its
  last-resort offline page, which is served when nothing is cached.

### Offline navigation

Offline, `sw.js` answers every navigation with the cached shell. It uses the
root entry (`./`) and falls back to `index.html`. Cloudflare Pages redirects
`/index.html` to `/`, and Chrome refuses a redirected response for a
navigation: it shows its no-internet page instead. So the worker rebuilds any
redirected response as a plain one, both when it precaches on install and
when it serves the shell. Devices pick up a new worker only after they open
the app once while online.
- The manifest `name` and `short_name` copy `app_title` and `app_short_name`.

Repo-ci fails if:

- any copy drifts from the table
- a key used in HTML, or passed literally to `t()` or `setStatus()`, is
  missing from the table
- a `setStatus()` key has no fallback copy
- any Hindi literal in the shell is not a table string

Keys passed through variables are not traced. To change text, edit the table
and then its copies.

### Font

`fonts/noto-sans-devanagari-subset.woff2` is Noto Sans Devanagari Regular
(SIL Open Font License 1.1; licence text in `fonts/OFL.txt`). It is subset to:

- Basic Latin and NBSP
- Devanagari (U+0900-097F) and Devanagari Extended (U+A8E0-A8FF)
- ZWNJ/ZWJ, the rupee sign and the dotted circle

The subset keeps every OpenType layout feature, so conjuncts and matras shape
correctly. `styles.css` loads it with `@font-face` and `font-display: swap`,
`index.html` preloads the same URL, and `sw.js` precaches it. To build or
rebuild it (needs network access and `pip install fonttools brotli`), run:

```
sh scripts/build_font.sh
```

The script prints how many code points in each range have glyphs and then
runs the repo check, including the 400 KB budget.

### Design tokens

`styles.css` defines these tokens on `:root`. Every later screen should use
them:

- colour: `--color-primary`, `--color-primary-strong`, `--color-on-primary`,
  `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`,
  `--color-border`, `--color-focus`
- spacing: `--space-1` … `--space-6` (4 px grid)
- radius: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`
- type: `--font-family-base`, `--font-size-sm` … `--font-size-xl` (never below
  16 px), `--line-height-body`, `--line-height-heading`
- layout: `--touch-target` (48 px), `--content-max-width`, `--shadow-card`

The header, `.btn-primary` and `.empty-state` take their colours only from
these tokens. The `theme-color` meta tag and the manifest's `theme_color` and
`background_color` must equal `--color-primary` and `--color-bg`.

It must be served from a domain root (the repo has a `CNAME`, so it is served
at the candidate's own domain). The manifest's `start_url` and `scope` are `/`;
a subpath deployment such as a GitHub Pages project site would need them
changed.

Run locally:

```
node relay/server.mjs   # shell + /roll relay on :8080 (python3 -m http.server has no relay)
# Chrome DevTools > Application > Manifest: no installability errors
# DevTools > Network > Offline, reload: shell still renders
# Device toolbar 360x740, Offline, reload: the Hindi title and empty state
# render in Noto Sans Devanagari, conjuncts correct, no horizontal scroll
```

These DevTools steps (Chrome's installability check and the Offline reload)
are not covered by the repo checks and still have to be run in a browser.

The repo checks also cover the Hindi UI shell:

- the string table and its copies, as described above
- `index.html` has no other inline text and no English user-visible
  attributes
- the `@font-face` rule loads a WOFF2 file from `fonts/` (checked by its
  `wOF2` header) with `font-display: swap`
- the font preload matches the `@font-face` URL
- the font and the string table are precached
- `:root` has colour, spacing, radius and type-scale tokens
- the header, button and empty state use no colour literals
- `.btn-primary` is at least 48 px tall
- body type is at least 16 px
- no `width` or `min-width` is over 360 px
- `em`, `calc()` and other widths or heights the check cannot resolve are
  reported as errors, not skipped

The 360 px check is a static CSS check, not a browser render, so the browser
steps above are still needed.

Repo checks: `python3 scripts/check_pwa_shell.py` (or
`cd scripts && python3 -m unittest test_pwa_shell`). When `node` is installed
they also syntax-check `sw.js` and run it in a stubbed worker sandbox
(`scripts/sw_behavior_test.cjs`, which `npm test` also runs) to assert the
install, activate and offline-navigation behaviour. CI runs all of these.
