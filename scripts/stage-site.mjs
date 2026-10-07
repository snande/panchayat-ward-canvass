// Stages the files Cloudflare Pages publishes as static assets into an output
// directory (default dist/). Only the browser-facing shell goes in: relay/,
// fixtures/, tests and tooling stay out. functions/ is not staged because
// `wrangler pages deploy` reads it from the working directory, and the relay
// code it imports is bundled into the function, not served. CNAME is a GitHub
// Pages artefact that Cloudflare does not use, so it is not staged.
//
//   node scripts/stage-site.mjs [outDir]
//
// After copying, every path in sw.js's PRECACHE list must exist in the output,
// so a new shell file that is not staged fails here instead of breaking the
// installed PWA's offline install on the live site.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STAGED = [
  '_routes.json', 'index.html', 'manifest.webmanifest', 'styles.css', 'sw.js',
  'config', 'fonts', 'icons', 'js', 'src',
];

const isTest = (name) => /\.test\.[cm]?js$/.test(name);

/** Paths listed in sw.js's PRECACHE array. */
export function precachePaths(swSource) {
  const block = /const PRECACHE = \[([\s\S]*?)\];/.exec(swSource);
  if (!block) throw new Error('PRECACHE list not found in sw.js');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function stageSite(outDir, sourceRoot = root) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const entry of STAGED) {
    cpSync(join(sourceRoot, entry), join(outDir, entry), {
      recursive: true,
      filter: (src) => !isTest(src),
    });
  }
  const missing = precachePaths(readFileSync(join(sourceRoot, 'sw.js'), 'utf8'))
    .filter((p) => p !== './' && !existsSync(join(outDir, p)));
  if (missing.length) throw new Error(`sw.js precaches paths missing from the staged site: ${missing.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] || join(root, 'dist'));
  stageSite(outDir);
  console.log(`staged site in ${outDir}`);
}
