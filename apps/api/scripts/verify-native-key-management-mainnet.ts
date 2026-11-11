// Read-only mainnet protocol check. Ephemeral keys, query/simulation only; never broadcasts.
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { SoftAuthenticator } from '../src/test/authenticator.js';
import {
  nativeAccountId,
  nativePublicKey,
  payloadChallenge,
  signedIntent,
} from '../src/accounts/native-signing.js';

async function view<T = unknown>(method: string, args: object): Promise<T> {
  const response = await fetch('https://rpc.mainnet.near.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: 'intents.near',
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  const b = (await response.json()) as {
    result?: { result?: number[]; error?: string };
    error?: unknown;
  };
  if (!response.ok || b.error || b.result?.error || !b.result?.result)
    throw new Error(b.result?.error ?? 'Query failed');
  return JSON.parse(Buffer.from(b.result.result).toString()) as T;
}
const salt = await view('current_salt', {});
if (typeof salt !== 'string' || !/^[0-9a-f]{8}$/.test(salt))
  throw new Error('Invalid current salt');
const original = new SoftAuthenticator({
  origin: 'https://app.usetendr.tech',
  rpId: 'usetendr.tech',
});
const backup = new SoftAuthenticator({
  origin: 'https://app.usetendr.tech',
  rpId: 'usetendr.tech',
});
const replacement = new SoftAuthenticator({
  origin: 'https://app.usetendr.tech',
  rpId: 'usetendr.tech',
});
const key = (auth: SoftAuthenticator) => {
  const { x, y } = auth.rawPublicKey;
  return nativePublicKey(Buffer.concat([Buffer.from([4]), x, y!]).toString('base64'));
};
const accountId = nativeAccountId(key(original));
const secret = randomBytes(32);
const recoveryKey = `ed25519:${bs58.encode(ed25519.getPublicKey(secret))}`;
const payload = (intents: object[]) =>
  JSON.stringify({
    signer_id: accountId,
    verifying_contract: 'intents.near',
    deadline: new Date(Date.now() + 300_000).toISOString(),
    nonce: Buffer.concat([Buffer.from(salt, 'hex'), randomBytes(28)]).toString('base64'),
    intents,
  });
const passkey = (auth: SoftAuthenticator, intents: object[]) => {
  const p = payload(intents);
  return signedIntent(p, key(auth), auth.assert(payloadChallenge(p)).response);
};
const recovery = (intents: object[]) => {
  const p = payload(intents);
  return {
    standard: 'raw_ed25519',
    payload: p,
    public_key: recoveryKey,
    signature: `ed25519:${bs58.encode(ed25519.sign(Buffer.from(p), secret))}`,
  };
};
const sequence = [
  passkey(original, [
    { intent: 'add_public_key', public_key: key(backup) },
    { intent: 'add_public_key', public_key: recoveryKey },
  ]),
  passkey(backup, [{ intent: 'remove_public_key', public_key: key(original) }]),
  recovery([
    { intent: 'add_public_key', public_key: key(replacement) },
    { intent: 'remove_public_key', public_key: key(backup) },
  ]),
  passkey(replacement, []),
];
const accepted = await view<{ intents_executed?: unknown[]; invariant_violated?: unknown }>(
  'simulate_intents',
  { signed: sequence },
);
if (accepted.intents_executed?.length !== 4 || accepted.invariant_violated)
  throw new Error('Key lifecycle was not accepted');
for (const auth of [original, backup]) {
  let rejected = false;
  try {
    await view('simulate_intents', { signed: [...sequence, passkey(auth, [])] });
  } catch (e) {
    rejected = /public key|public_key|invalid signature|not found/i.test(String(e));
  }
  if (!rejected) throw new Error('Removed key remained authorized');
}
secret.fill(0);
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      network: 'mainnet',
      addedBackupPasskey: true,
      addedRecoveryKey: true,
      originalKeyRevoked: true,
      recoveredSameAccount: true,
      removedKeysRejected: true,
      broadcasts: 0,
      fundsMoved: false,
    },
    null,
    2,
  ),
);
