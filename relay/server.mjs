// Serves the PWA and the roll relay from one origin:
//
//   node relay/server.mjs            # PORT=8080 HOST=127.0.0.1 by default
//
// GET /roll?url=... goes to relay/rollRelay.mjs, which relays any SEC ward
// roll PDF URL of the catalogue's shape (isSecRollUrl) and the pdfUrl of
// every ward in config/constituency.json (read at startup).
// Everything else is a static file from the shell's own files and
// directories (PUBLIC below); the rest of the repo (fixtures with real voter
// data, tools, tests outside src/) is never served.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { allowedRollUrls, createRollRelay, isSecRollUrl, RELAY_PATH } from './rollRelay.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const PUBLIC_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'styles.css']);
const PUBLIC_DIRS = new Set(['js', 'src', 'fonts', 'icons', 'config']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** Repo-relative file for a request path, or null if it is not public. */
export function publicFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel === '/') rel = '/index.html';
  const parts = rel.split('/').slice(1);
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.') || p.includes('\\') || p.includes('\0'))) {
    return null;
  }
  const ok = parts.length === 1 ? PUBLIC_FILES.has(parts[0]) : PUBLIC_DIRS.has(parts[0]);
  if (!ok || !Object.prototype.hasOwnProperty.call(TYPES, path.extname(rel))) return null;
  return parts.join('/');
}

async function sendResponse(res, response, head) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(head ? undefined : Buffer.from(await response.arrayBuffer()));
}

/**
 * @param {{root?: string, relay?: (request: Request) => Promise<Response>,
 *   fetch?: typeof fetch}} [options]
 * fetch is the default relay's upstream fetch (tests stub it).
 */
export async function createAppServer({ root = REPO_ROOT, relay, fetch = globalThis.fetch } = {}) {
  if (!relay) {
    const config = JSON.parse(await readFile(path.join(root, 'config/constituency.json'), 'utf8'));
    relay = createRollRelay({ allowedUrls: allowedRollUrls(config), isAllowedUrl: isSecRollUrl, fetch });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === RELAY_PATH) {
        const response = await relay(new Request(url, { method: req.method }));
        await sendResponse(res, response, req.method === 'HEAD');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      const rel = publicFile(url.pathname);
      const file = rel && path.join(root, rel);
      const info = file && (await stat(file).catch(() => null));
      if (!info || !info.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)],
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      console.error('request failed', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('server error\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const server = await createAppServer();
  server.listen(port, host, () => {
    console.log(`ward canvass on http://${host}:${port}/ (roll relay at ${RELAY_PATH})`);
  });
}
