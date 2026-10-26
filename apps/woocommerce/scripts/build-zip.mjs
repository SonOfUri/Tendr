#!/usr/bin/env node
// Builds the installable plugin: dist/tendr-pay-with-crypto-<version>.zip (and a .sha256 next to
// it), from an allowlist of shipped files only (no tests, vendor, Composer or wp-env files). The
// zip is deterministic: sorted entries, fixed timestamps and permissions, so the same source always
// gives the same sha256.
//
// Then, unless --no-publish, it copies the zip to apps/web/public/downloads/woocommerce/ and writes
// that folder's manifest.json, which the web app serves as the update feed
// (GET /v1/plugins/woocommerce/update.json) and the downloads page. The zip there is gitignored:
// a release commits the manifest and publishes the zip with the web app (README → WooCommerce).
//
//   node apps/woocommerce/scripts/build-zip.mjs [--no-publish]
//
// Prints one JSON line: {version, file, path, sha256, bytes, entries}.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DOWNLOADS = resolve(ROOT, '../web/public/downloads/woocommerce');
const SLUG = 'tendr-pay-with-crypto';

/** What ships: these files and directories (recursively), relative to the plugin root. */
const SHIPPED = ['tendr-pay-with-crypto.php', 'uninstall.php', 'readme.txt', 'includes', 'assets'];
/** Never shipped, even inside a shipped directory. */
const FORBIDDEN = /(^|\/)(\.|node_modules\/|vendor\/|tests?\/|composer\.|phpunit|phpcs|package)/;

/** 2000-01-01 00:00:00 in MS-DOS date/time (local fields; the zip format has no time zone). */
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

function fail(message) {
  console.error(`build-zip: ${message}`);
  process.exit(1);
}

/** A header field of the main plugin file or readme.txt (`Name: value`). */
function header(text, name) {
  const m = new RegExp(`^[ \\t*#@]*${name}:[ \\t]*(.+?)\\s*$`, 'mi').exec(text);
  return m ? m[1] : null;
}

/** Every shipped file, as a sorted list of `/`-separated paths relative to ROOT. */
function shippedFiles() {
  const out = [];
  const walk = (abs) => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) walk(join(abs, name));
    } else if (st.isFile()) {
      out.push(relative(ROOT, abs).split(sep).join('/'));
    }
  };
  for (const entry of SHIPPED) walk(join(ROOT, entry));
  out.sort();
  for (const path of out) {
    if (FORBIDDEN.test(path)) fail(`refusing to ship ${path}`);
  }
  return out;
}

/** A zip archive (PKZIP 2.0, deflate) of `entries`: [{name, data|null for a directory}]. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const isDir = data === null;
    const raw = isDir ? Buffer.alloc(0) : data;
    const deflated = isDir ? raw : deflateRawSync(raw, { level: 9 });
    const stored = isDir || deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const crc = isDir ? 0 : crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    // External attributes: Unix mode in the high 16 bits (dir 0755, file 0644), plus MS-DOS dir bit.
    const mode = isDir ? 0o40755 : 0o100644;
    central.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function main() {
  const publish = !process.argv.includes('--no-publish');

  const mainFile = readFileSync(join(ROOT, `${SLUG}.php`), 'utf8');
  const readme = readFileSync(join(ROOT, 'readme.txt'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = header(mainFile, 'Version');
  const constant = /define\(\s*'TENDR_VERSION',\s*'([^']+)'\s*\)/.exec(mainFile)?.[1];
  const stable = header(readme, 'Stable tag');
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail(`bad Version header: ${version}`);
  for (const [label, v] of [
    ['TENDR_VERSION', constant],
    ['readme.txt Stable tag', stable],
    ['package.json version', pkg.version],
  ]) {
    if (v !== version) fail(`${label} is ${v}, but the plugin header says ${version}`);
  }
  const requires = header(readme, 'Requires at least');
  const tested = header(readme, 'Tested up to');
  const requiresPhp = header(readme, 'Requires PHP');
  for (const [label, v] of [
    ['Requires at least', requires],
    ['Tested up to', tested],
    ['Requires PHP', requiresPhp],
  ]) {
    if (!v || !/^\d+(\.\d+){0,2}$/.test(v)) fail(`readme.txt ${label} is missing or malformed`);
  }
  if (header(mainFile, 'Requires at least') !== requires)
    fail('Requires at least differs from readme');
  if (header(mainFile, 'Requires PHP') !== requiresPhp) fail('Requires PHP differs from readme');

  const files = shippedFiles();
  const dirs = new Set([`${SLUG}/`]);
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${SLUG}/${parts.slice(0, i).join('/')}/`);
  }
  const entries = [
    ...[...dirs].sort().map((name) => ({ name, data: null })),
    ...files.map((f) => ({ name: `${SLUG}/${f}`, data: readFileSync(join(ROOT, f)) })),
  ];
  const archive = zip(entries);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const file = `${SLUG}-${version}.zip`;

  const dist = join(ROOT, 'dist');
  mkdirSync(dist, { recursive: true });
  const path = join(dist, file);
  writeFileSync(path, archive);
  writeFileSync(`${path}.sha256`, `${sha256}  ${file}\n`);

  if (publish) {
    mkdirSync(WEB_DOWNLOADS, { recursive: true });
    copyFileSync(path, join(WEB_DOWNLOADS, file));
    const manifest = { version, file, sha256, requires, tested, requires_php: requiresPhp };
    writeFileSync(join(WEB_DOWNLOADS, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  process.stdout.write(
    `${JSON.stringify({ version, file, path, sha256, bytes: archive.length, entries: entries.length, published: publish })}\n`,
  );
}

main();
