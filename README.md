# panchayat-ward-canvass

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
- No app route calls it yet. That wiring waits for the ward-picker deliverable's on-device roll reader.

Tests in `test/searchScreen.test.js` run with `npm test` (and in CI) against a small in-process fake DOM (`test/helpers/fakeDom.js`), not jsdom or a browser, so no extra dependencies are needed. The timing bound and the `lang`/`inputmode` attributes are therefore verified in that test DOM environment, not on a real Android Chrome device.

## PWA shell

The installable Hindi shell is plain static files: `index.html`,
`manifest.webmanifest`, `sw.js`, `css/`, `js/` and `icons/`. It makes no
requests to other origins and the precached assets stay under 400 KB.

It must be served from a domain root (the repo has a `CNAME`, so it is served
at the candidate's own domain). The manifest's `start_url` and `scope` are `/`;
a subpath deployment such as a GitHub Pages project site would need them
changed.

Run locally:

```
python3 -m http.server 8080
# Chrome DevTools > Application > Manifest: no installability errors
# DevTools > Network > Offline, reload: shell still renders
```

These DevTools steps (Chrome's installability check and the Offline reload)
are not covered by the repo checks and still have to be run in a browser.

Repo checks: `python3 scripts/check_pwa_shell.py` (or
`cd scripts && python3 -m unittest test_pwa_shell`). When `node` is installed
they also syntax-check `sw.js` and run it in a stubbed worker sandbox
(`scripts/sw_behavior_test.cjs`, which `npm test` also runs) to assert the
install, activate and offline-navigation behaviour. CI runs all of these.
