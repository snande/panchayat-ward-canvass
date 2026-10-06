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
`manifest.webmanifest`, `sw.js`, `css/`, `js/`, `icons/`, `fonts/` and
`src/strings.hi.json`. It makes no requests to other origins, and the
precached assets, font included, stay under 400 KB.

### Hindi strings

All visible shell text is in `src/strings.hi.json`, a flat key-to-Hindi map.
In `index.html`, elements name their string with `data-i18n="<key>"` and
contain no text of their own. At startup, `js/app.js` fetches the table
(precached, so this works offline) and fills those elements and
`document.title`. To add text, add a key to the table instead of writing
text in HTML or JS.

### Font

`fonts/noto-sans-devanagari-subset.woff2` is Noto Sans Devanagari Regular
(SIL Open Font License 1.1; licence text in `fonts/OFL.txt`). It is subset to
Basic Latin, the Devanagari blocks, ZWNJ/ZWJ, the dotted circle and the rupee
sign, and it keeps all OpenType layout features so conjuncts and matras shape
correctly. `css/app.css` loads it with `@font-face` and `font-display: swap`,
and `sw.js` precaches it. To rebuild it (needs network access and
`pip install fonttools brotli`), run:

```
sh scripts/build_font.sh
```

### Design tokens

`css/app.css` (the shell's stylesheet) defines these tokens on `:root`. Every
later screen should use them:

- colour: `--color-primary`, `--color-primary-strong`, `--color-on-primary`,
  `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`,
  `--color-border`, `--color-focus`
- spacing: `--space-1` … `--space-6` (4 px grid)
- radius: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`
- type: `--font-family-base`, `--font-size-sm` … `--font-size-xl` (never below
  16 px), `--line-height-body`, `--line-height-heading`
- layout: `--touch-target` (48 px), `--content-max-width`, `--shadow-card`

The header, `.btn-primary` and `.empty-state` must take their colours from
these tokens. The repo check rejects colour literals in those rules.

It must be served from a domain root (the repo has a `CNAME`, so it is served
at the candidate's own domain). The manifest's `start_url` and `scope` are `/`;
a subpath deployment such as a GitHub Pages project site would need them
changed.

Run locally:

```
python3 -m http.server 8080
# Chrome DevTools > Application > Manifest: no installability errors
# DevTools > Network > Offline, reload: shell still renders
# Device toolbar 360x740, Offline, reload: Hindi title and the empty state
# render in Noto Sans Devanagari with no horizontal scroll
```

These DevTools steps (Chrome's installability check and the Offline reload)
are not covered by the repo checks and still have to be run in a browser.

The repo checks also cover the Hindi UI shell:

- every string-table value is Devanagari with no Latin letters
- `index.html` has no inline text or English user-visible attributes
- every `data-i18n` key resolves
- the `@font-face` rule loads a WOFF2 from `fonts/` with `font-display: swap`
- the font and the string table are precached
- `:root` has the four token families (colour, spacing, radius, type scale)
- the header, button and empty state use no colour literals
- `.btn-primary` is at least 48 px tall
- body type is at least 16 px
- no fixed `width` or `min-width` is over 360 px

The 360 px check is a static CSS check, not a browser render.

Repo checks: `python3 scripts/check_pwa_shell.py` (or
`cd scripts && python3 -m unittest test_pwa_shell`). When `node` is installed
they also syntax-check `sw.js` and run it in a stubbed worker sandbox
(`scripts/sw_behavior_test.cjs`, which `npm test` also runs) to assert the
install, activate and offline-navigation behaviour. CI runs all of these.
