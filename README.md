# panchayat-ward-canvass

## Search screen

`src/ui/searchScreen.js` is the on-phone voter search screen. It is plain DOM with no framework:

```js
import { mountSearchScreen } from './src/ui/searchScreen.js';

const screen = mountSearchScreen(document.body, voters); // voters: [{ id, serial, name, relativeName, houseNo }]
// screen.destroy() unmounts it
```

- Shows one Hindi input (`lang="hi"`, `inputmode="text"`, placeholder `नाम खोजें`). Each query is debounced by 100 ms and shows up to 50 results, with name, relative, serial and house number in each row.
- An exact full-name match is always listed first. When nothing matches, it shows `कोई मतदाता नहीं मिला`.
- Fully offline: it makes no network requests. The search index (from `src/search/hindiSearch.js`) is kept in memory only and is never written to `localStorage`, `sessionStorage` or `indexedDB`.
- No app route calls it yet. That wiring waits for the ward-picker deliverable's on-device roll reader.

Tests run with `npm test` against a small in-process fake DOM (`test/helpers/fakeDom.js`), so no extra dependencies are needed.
