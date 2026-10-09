// Cold-start budget for the app shell (quality bar "Fast": cold start under
// 3 s on a 2 GB phone). `npm test` runs it on the real tree through
// scripts/check_startup_budget.test.mjs, which also tests it on fixtures.
//
// Three checks, all on the files on disk:
// 1. The static import graph of every script index.html loads (js/app.js and
//    js/picker.js) never reaches src/decoder/. The decoder and its glyph
//    table come in only through import() when a PDF has to be decoded.
// 2. The startup critical path — index.html, styles.css, js/app.js plus its
//    transitive static imports, and the Devanagari font — is at most 350 KB.
// 3. sw.js precaches every shell file: the page, the stylesheet, the
//    manifest, the font and every module in the graph of check 1, so a
//    repeat cold start of the installed app needs no network request.
//
// Usage: node scripts/check_startup_budget.mjs [--root <dir>]
// Prints the critical-path total in KB; exits 1 if any check fails.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUDGET_BYTES = 350 * 1024;
export const DECODER_DIR = 'src/decoder/';
export const FONT = 'fonts/noto-sans-devanagari-subset.woff2';
const APP = 'js/app.js';
// Shell files sw.js must precache besides the script graph.
const SHELL_FILES = ['index.html', 'styles.css', 'manifest.webmanifest', FONT];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// After one of these characters, or one of these keywords, a "/" starts a
// regex literal; after anything else (an identifier, a number, ")" or "]")
// it is division.
const REGEX_AFTER_CHAR = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function regexAllowed(out) {
  let k = out.length - 1;
  while (k >= 0 && /\s/.test(out[k])) k--;
  if (k < 0) return true;
  if (REGEX_AFTER_CHAR.has(out[k])) return true;
  const word = /[A-Za-z_$][\w$]*$/.exec(out.slice(Math.max(0, k - 15), k + 1));
  return word !== null && REGEX_AFTER_WORD.has(word[0]);
}

// The index just past the regex literal starting at source[i], or -1 if no
// literal closes on this line (then the "/" was division after all).
function regexEnd(source, i) {
  let inClass = false;
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j];
    if (c === '\n') return -1;
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < source.length && /[a-z]/i.test(source[j])) j++;
      return j;
    }
  }
  return -1;
}

// Remove // and /* */ comments and blank out regex literals, leaving string
// and template literals alone. A commented-out import is then not counted,
// and a quote or "//" inside a string or regex such as /'/ or /https?:\/\//
// cannot swallow the imports after it.
export function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        else if (c !== '`' && source[j] === '\n') break;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const block = source.slice(i, end < 0 ? source.length : end + 2);
      out += block.replace(/[^\n]/g, ' ');
      i = end < 0 ? source.length : end + 2;
    } else if (c === '/' && regexAllowed(out) && regexEnd(source, i) > 0) {
      const end = regexEnd(source, i);
      out += '0' + ' '.repeat(end - i - 1);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// A static import or re-export at the start of a statement:
//   import x from '…';  import { a,\n b } from '…';  import '…';
//   export * from '…';  export { a } from '…';
// import('…') and import.meta are not matched: after the keyword comes
// whitespace and then either a quote or a clause ending in `from`.
const STATIC_IMPORT = /(?:^|[;}\n])\s*(?:import|export)\s+(?:[^'"`;()]*?\s*\bfrom\s*)?(['"])([^'"\n]+)\1/g;

/** The specifiers of every static import and re-export in a JS module. */
export function staticImports(source) {
  const code = stripComments(source);
  const specs = [];
  for (const m of code.matchAll(STATIC_IMPORT)) specs.push(m[2]);
  return specs;
}

/** The src of every <script> in an HTML page, comments ignored. */
export function htmlScripts(html) {
  const page = html.replace(/<!--[\s\S]*?-->/g, '');
  const srcs = [];
  for (const m of page.matchAll(/<script\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi)) {
    srcs.push(m[2]);
  }
  return srcs;
}

// Resolve a specifier to a repo-relative path, or null for one the shell
// cannot load from its own origin (bare package names, other origins).
function resolveSpecifier(fromRel, spec) {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(spec)) return null;
  const path = spec.split(/[?#]/)[0];
  if (path.startsWith('/')) return posix.normalize(path.slice(1));
  if (!path.startsWith('./') && !path.startsWith('../')) return null;
  return posix.normalize(posix.join(posix.dirname(fromRel), path));
}

/**
 * Walk the static import graph from the given entry files.
 * @returns {{files: string[], parent: Map<string, string|null>, errors: string[]}}
 *   files in visit order; parent maps each file to the one importing it.
 */
export function walkStaticGraph(root, entries) {
  const parent = new Map();
  const errors = [];
  const queue = [];
  for (const entry of entries) {
    if (!parent.has(entry)) {
      parent.set(entry, null);
      queue.push(entry);
    }
  }
  for (let k = 0; k < queue.length; k++) {
    const rel = queue[k];
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      errors.push(`${rel} does not exist` + (parent.get(rel) ? ` (imported by ${parent.get(rel)})` : ''));
      continue;
    }
    for (const spec of staticImports(readFileSync(abs, 'utf8'))) {
      const dep = resolveSpecifier(rel, spec);
      if (dep === null) {
        errors.push(`${rel} imports ${spec}, which the offline shell cannot load`);
        continue;
      }
      if (!parent.has(dep)) {
        parent.set(dep, rel);
        queue.push(dep);
      }
    }
  }
  return { files: queue, parent, errors };
}

// "js/app.js -> src/a.js -> src/decoder/x.js"
function chain(parent, file) {
  const path = [];
  for (let f = file; f !== null && f !== undefined; f = parent.get(f)) path.unshift(f);
  return path.join(' -> ');
}

/** The string entries of `const PRECACHE = [ ... ];` in sw.js, or null. */
export function parsePrecache(swText) {
  const start = swText.match(/PRECACHE\s*=\s*\[/);
  if (!start) return null;
  const body = stripComments(swText.slice(start.index + start[0].length));
  const entries = [];
  const token = /\s*(?:(["'])((?:\\.|(?!\1).)*)\1|(,)|(\]))/y;
  let m;
  while ((m = token.exec(body))) {
    if (m[4]) return entries;
    if (m[2] !== undefined) entries.push(m[2]);
  }
  return null;
}

/**
 * Run all three checks on the tree at `root`.
 * @returns {{totalBytes: number, files: string[], errors: string[]}}
 *   files: the critical path whose bytes make up totalBytes.
 */
export function checkStartupBudget(root = ROOT) {
  const errors = [];
  const html = existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html'), 'utf8') : '';
  if (!html) errors.push('index.html is missing or empty');

  // 1. No static path from the page's scripts to the decoder.
  const entries = [APP];
  for (const src of htmlScripts(html)) {
    const rel = resolveSpecifier('index.html', src.startsWith('.') || src.startsWith('/') ? src : './' + src);
    if (rel === null) errors.push(`index.html loads ${src}, which the offline shell cannot load`);
    else if (!entries.includes(rel)) entries.push(rel);
  }
  const shell = walkStaticGraph(root, entries);
  errors.push(...shell.errors);
  for (const file of shell.files) {
    // Name only the import that crosses into the decoder, not its subtree.
    if (file.startsWith(DECODER_DIR) && !(shell.parent.get(file) ?? '').startsWith(DECODER_DIR)) {
      errors.push(`static import reaches the decoder: ${chain(shell.parent, file)} (use import() instead)`);
    }
  }

  // 2. The critical path fits the budget. A missing module of the graph was
  // already reported by the walk above.
  const app = walkStaticGraph(root, [APP]);
  const files = ['index.html', 'styles.css', ...app.files, FONT];
  let totalBytes = 0;
  for (const file of files) {
    const abs = join(root, file);
    if (existsSync(abs)) totalBytes += statSync(abs).size;
    else if (!app.files.includes(file)) errors.push(`${file} does not exist`);
  }
  if (totalBytes > BUDGET_BYTES) {
    errors.push(`startup critical path is ${kb(totalBytes)} KB, over the ${kb(BUDGET_BYTES)} KB budget`);
  }

  // 3. sw.js precaches every shell file.
  const swPath = join(root, 'sw.js');
  const precache = existsSync(swPath) ? parsePrecache(readFileSync(swPath, 'utf8')) : null;
  if (precache === null) {
    errors.push('sw.js needs a PRECACHE list');
  } else {
    const cached = new Set(precache.map((p) => posix.normalize(p.replace(/^\.\//, ''))));
    for (const need of [...SHELL_FILES, ...shell.files]) {
      if (!cached.has(need)) errors.push(`sw.js PRECACHE lacks ${need}`);
    }
  }

  return { totalBytes, files, errors };
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1);
}

function main(argv) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? resolve(argv[at + 1] ?? '') : ROOT;
  const { totalBytes, files, errors } = checkStartupBudget(root);
  console.log(`startup critical path: ${files.length} files, ${kb(totalBytes)} KB (budget ${kb(BUDGET_BYTES)} KB)`);
  for (const e of errors) console.error('FAIL: ' + e);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
