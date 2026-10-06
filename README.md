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
python3 -m http.server 8080
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
