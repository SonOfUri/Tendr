// Copies the latin .woff2 of every curated theme font (and Tendr's own Sora, Instrument Sans and
// JetBrains Mono, which are on the curated list) from @fontsource into public/fonts/<id>.woff2,
// where ThemeStyles and globals.css load them. Run by `predev` and `prebuild`; the output is
// gitignored. Variable builds are used where @fontsource publishes one (one file covers every
// weight); DM Serif Display only ships a regular weight.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');

/** Curated font id (CURATED_FONTS in @tendr/contracts) → [package, file in its files/]. */
const FONTS = {
  inter: ['@fontsource-variable/inter', 'inter-latin-wght-normal.woff2'],
  'dm-sans': ['@fontsource-variable/dm-sans', 'dm-sans-latin-wght-normal.woff2'],
  manrope: ['@fontsource-variable/manrope', 'manrope-latin-wght-normal.woff2'],
  'plus-jakarta-sans': [
    '@fontsource-variable/plus-jakarta-sans',
    'plus-jakarta-sans-latin-wght-normal.woff2',
  ],
  'space-grotesk': ['@fontsource-variable/space-grotesk', 'space-grotesk-latin-wght-normal.woff2'],
  outfit: ['@fontsource-variable/outfit', 'outfit-latin-wght-normal.woff2'],
  sora: ['@fontsource-variable/sora', 'sora-latin-wght-normal.woff2'],
  'instrument-sans': [
    '@fontsource-variable/instrument-sans',
    'instrument-sans-latin-wght-normal.woff2',
  ],
  'rethink-sans': [
    '@fontsource-variable/rethink-sans',
    'rethink-sans-latin-wght-normal.woff2',
  ],
  'bricolage-grotesque': [
    '@fontsource-variable/bricolage-grotesque',
    'bricolage-grotesque-latin-wght-normal.woff2',
  ],
  'playfair-display': [
    '@fontsource-variable/playfair-display',
    'playfair-display-latin-wght-normal.woff2',
  ],
  'cormorant-garamond': [
    '@fontsource-variable/cormorant-garamond',
    'cormorant-garamond-latin-wght-normal.woff2',
  ],
  lora: ['@fontsource-variable/lora', 'lora-latin-wght-normal.woff2'],
  fraunces: ['@fontsource-variable/fraunces', 'fraunces-latin-wght-normal.woff2'],
  'dm-serif-display': ['@fontsource/dm-serif-display', 'dm-serif-display-latin-400-normal.woff2'],
  'jetbrains-mono': [
    '@fontsource-variable/jetbrains-mono',
    'jetbrains-mono-latin-wght-normal.woff2',
  ],
};

mkdirSync(outDir, { recursive: true });
let missing = 0;
for (const [id, [pkg, file]] of Object.entries(FONTS)) {
  const from = join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file);
  if (!existsSync(from)) {
    console.error(`copy-fonts: ${pkg} has no files/${file}`);
    missing += 1;
    continue;
  }
  copyFileSync(from, join(outDir, `${id}.woff2`));
}
if (missing) process.exit(1);
console.log(`copy-fonts: ${Object.keys(FONTS).length} fonts in public/fonts`);
