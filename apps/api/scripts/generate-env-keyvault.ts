import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { KEY_NAMES, curveOf } from '../src/keyvault/keys.js';
import { validEnvironmentKeyBundle } from '../src/keyvault/environment.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: tsx scripts/generate-env-keyvault.ts <private-output-file>');
const bundle = {
  v: 1,
  kek: randomBytes(32).toString('base64'),
  keys: Object.fromEntries(
    KEY_NAMES.map((name) => [
      name,
      Buffer.from(
        curveOf(name) === 'secp256k1' ? secp256k1.utils.randomPrivateKey() : randomBytes(32),
      ).toString('base64'),
    ]),
  ),
};
const serialized = JSON.stringify(bundle);
if (!validEnvironmentKeyBundle(serialized))
  throw new Error('Generated key bundle failed validation');
const path = resolve(output);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, serialized + '\n', { flag: 'wx', mode: 0o600 });
console.log(
  `Saved software key bundle to ${path} (mode 0600). Keep a private backup; do not regenerate for redeploys.`,
);
