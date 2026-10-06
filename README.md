# panchayat-ward-canvass

## PWA shell

The installable Hindi shell is plain static files: `index.html`,
`manifest.webmanifest`, `sw.js`, `css/`, `js/` and `icons/`. It makes no
requests to other origins and the precached assets stay under 400 KB.

Run locally:

```
python3 -m http.server 8080
# Chrome DevTools > Application > Manifest: no installability errors
# DevTools > Network > Offline, reload: shell still renders
```

Repo checks: `python3 scripts/check_pwa_shell.py` (or
`cd scripts && python3 -m unittest test_pwa_shell`).
