// Broadcasts KEY-ONLY intents from a NEW ephemeral, unfunded account. Never loads merchant data.
// Run explicitly: node --import tsx apps/api/scripts/verify-native-key-relay-mainnet.ts --ephemeral-only
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';
import { loadEnv } from '../src/env.js';
import { HttpNativeKeyRelay } from '../src/accounts/native-key-relay.js';
import { SoftAuthenticator } from '../src/test/authenticator.js';
import {
  nativeAccountId,
  nativePublicKey,
  payloadChallenge,
  signedIntent,
} from '../src/accounts/native-signing.js';

if (!process.argv.includes('--ephemeral-only'))
  throw new Error(
    'Pass --ephemeral-only to authorize key-only transactions on a new empty account',
  );
loadDotenvFile('.env');
loadEnv();
const relay = new HttpNativeKeyRelay();
const original = new SoftAuthenticator();
const backup = new SoftAuthenticator();
const replacement = new SoftAuthenticator();
const key = (a: SoftAuthenticator) =>
  nativePublicKey(
    Buffer.concat([Buffer.from([4]), a.rawPublicKey.x, a.rawPublicKey.y!]).toString('base64'),
  );
const accountId = nativeAccountId(key(original));
const secret = randomBytes(32);
const recoveryKey = `ed25519:${bs58.encode(ed25519.getPublicKey(secret))}`;
type Intent = { intent: 'add_public_key' | 'remove_public_key'; public_key: string };
async function run(
  label: string,
  signer: SoftAuthenticator | 'recovery',
  intents: Intent[],
  expected: Record<string, boolean>,
) {
  const salt = await relay.salt();
  const nonce = Buffer.concat([Buffer.from(salt, 'hex'), randomBytes(28)]).toString('base64');
  const payload = JSON.stringify({
    signer_id: accountId,
    verifying_contract: 'intents.near',
    deadline: new Date(Date.now() + 300_000).toISOString(),
    nonce,
    intents,
  });
  const signed =
    signer === 'recovery'
      ? {
          standard: 'raw_ed25519',
          payload,
          public_key: recoveryKey,
          signature: `ed25519:${bs58.encode(ed25519.sign(Buffer.from(payload), secret))}`,
        }
      : signedIntent(payload, key(signer), signer.assert(payloadChallenge(payload)).response);
  const hash = await relay.publish(signed);
  for (let attempt = 0; attempt < 24; attempt++) {
    const state = await relay.state(accountId, Object.keys(expected), nonce);
    if (
      state.nonceUsed &&
      Object.entries(expected).every(([pk, present]) => state.keys[pk] === present)
    ) {
      console.log(
        JSON.stringify({
          step: label,
          confirmed: true,
          accountId,
          intentHash: hash,
          fundsMoved: false,
        }),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error(`Key-only ${label} was not confirmed in time`);
}
try {
  await run(
    'enable backup passkey and recovery kit',
    original,
    [
      { intent: 'add_public_key', public_key: key(backup) },
      { intent: 'add_public_key', public_key: recoveryKey },
    ],
    { [key(original)]: true, [key(backup)]: true, [recoveryKey]: true },
  );
  await run(
    'backup passkey revokes original',
    backup,
    [{ intent: 'remove_public_key', public_key: key(original) }],
    { [key(original)]: false, [key(backup)]: true },
  );
  await run(
    'offline kit recovers the same wallet',
    'recovery',
    [
      { intent: 'add_public_key', public_key: key(replacement) },
      { intent: 'remove_public_key', public_key: key(backup) },
    ],
    { [key(original)]: false, [key(backup)]: false, [key(replacement)]: true, [recoveryKey]: true },
  );
  await run(
    'replacement passkey can revoke recovery kit',
    replacement,
    [{ intent: 'remove_public_key', public_key: recoveryKey }],
    { [key(replacement)]: true, [recoveryKey]: false },
  );
} finally {
  secret.fill(0);
}
