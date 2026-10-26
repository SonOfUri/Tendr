// Builds tendr.js (src/embed/tendr.ts) into public/v1/tendr.js: one minified IIFE, no
// dependencies. The checkout's base URL is baked in from TENDR_CHECKOUT_BASE_URL (default
// https://usetendr.tech); tendr.js only frames, and only listens to, that origin.
//
// Runs before `next build` (the `prebuild` script) and before the e2e web server. The output is
// generated, not committed (.gitignore). Prints the size and fails above 10 KB.
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/embed/tendr.ts');
const outfile = resolve(here, '../public/v1/tendr.js');
const MAX_BYTES = 10 * 1024;

const baseUrl = process.env.TENDR_CHECKOUT_BASE_URL || 'https://usetendr.tech';
let origin;
try {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
  origin = u.origin;
} catch (err) {
  console.error(`build-embed: TENDR_CHECKOUT_BASE_URL is not an http(s) URL: ${baseUrl} (${err})`);
  process.exit(1);
}

mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2018'],
  minify: true,
  legalComments: 'none',
  define: { __TENDR_CHECKOUT_BASE_URL__: JSON.stringify(origin) },
  logLevel: 'warning',
});

const bytes = statSync(outfile).size;
const kb = (bytes / 1024).toFixed(2);
if (bytes > MAX_BYTES) {
  console.error(`build-embed: tendr.js is ${bytes} bytes (${kb} KB), over the 10 KB limit`);
  process.exit(1);
}
console.log(`build-embed: public/v1/tendr.js ${bytes} bytes (${kb} KB, limit 10 KB) for ${origin}`);
