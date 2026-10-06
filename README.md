# panchayat-ward-canvass

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
(`scripts/sw_behavior_test.js`) to assert the install, activate and
offline-navigation behaviour.
