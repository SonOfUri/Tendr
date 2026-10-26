#!/usr/bin/env node
// Runs WordPress.org's Plugin Check (the `plugin-check` plugin, pinned in .wp-env.e2e.json) on the
// built zip, exactly as a store would install it: the zip from dist/ (build-zip.mjs) is installed
// in the e2e WordPress site and checked there. Fails on any error; lists warnings.
//
//   npm run build:zip -- --no-publish && npm run env:start:e2e && npm run plugin-check
//   (all with --workspace=@tendr/woocommerce)
//
// `wp plugin check` exits 0 even when it reports errors, so this script reads its JSON instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = '--config=.wp-env.e2e.json';
const SLUG = 'tendr-pay-with-crypto';

/**
 * The text domain is `tendr` (global constraint: "Text domain `tendr`"), so the check is told the
 * slug that domain belongs to. Plugin Check otherwise expects the folder name as the domain.
 */
const TEXT_DOMAIN_SLUG = 'tendr';

/** Result codes not counted, each with why. */
const IGNORED = {
  plugin_updater_detected:
    'The pilot is distributed from usetendr.tech with its own update feed (spec §9); a WordPress.org build must drop includes/class-tendr-updater.php.',
};

function wpCli(args) {
  return execFileSync('npx', ['wp-env', 'run', CONFIG, 'cli', '--', 'wp', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const zip = `wp-content/tendr-dist/${SLUG}-${version}.zip`;
wpCli(['plugin', 'install', zip, '--force', '--activate']);

const out = wpCli([
  'plugin',
  'check',
  SLUG,
  `--slug=${TEXT_DOMAIN_SLUG}`,
  `--ignore-codes=${Object.keys(IGNORED).join(',')}`,
  '--format=json',
]);

const results = [];
let file = null;
for (const line of out.split('\n')) {
  const t = line.trim();
  if (t.startsWith('FILE: ')) file = t.slice('FILE: '.length);
  else if (t.startsWith('[')) for (const r of JSON.parse(t)) results.push({ file, ...r });
}

const errors = results.filter((r) => r.type === 'ERROR');
const warnings = results.filter((r) => r.type !== 'ERROR');
const show = (r) => `  ${r.type} ${r.file}:${r.line} ${r.code}: ${r.message}`;
console.log(`Plugin Check: ${errors.length} error(s), ${warnings.length} warning(s)`);
for (const [code, why] of Object.entries(IGNORED)) console.log(`  ignored ${code}: ${why}`);
for (const r of warnings) console.log(show(r));
for (const r of errors) console.error(show(r));
process.exit(errors.length > 0 ? 1 : 0);
