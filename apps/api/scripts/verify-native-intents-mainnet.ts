// Read-only compatibility check. Ephemeral key, empty intents, query RPC only; never broadcasts.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { p256 } from '@noble/curves/p256';
import {
  activationPayload,
  nativeAccountId,
  nativePublicKey,
  payloadChallenge,
  signedIntent,
} from '../src/accounts/native-signing.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest();
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = pair.publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x!, 'base64url'),
  Buffer.from(jwk.y!, 'base64url'),
]);
const publicKey = nativePublicKey(
  Buffer.from(p256.ProjectivePoint.fromHex(raw).toRawBytes(true)).toString('base64'),
);
const accountId = nativeAccountId(publicKey);
const payload = activationPayload(accountId, 'intents.near', new Date(Date.now() + 300_000));
const client = JSON.stringify({
  type: 'webauthn.get',
  challenge: payloadChallenge(payload),
  origin: 'https://app.usetendr.tech',
  crossOrigin: false,
});
const auth = Buffer.concat([sha('usetendr.tech'), Buffer.from([5, 0, 0, 0, 1])]);
const signed = signedIntent(payload, publicKey, {
  clientDataJSON: Buffer.from(client).toString('base64url'),
  authenticatorData: auth.toString('base64url'),
  signature: sign('sha256', Buffer.concat([auth, sha(client)]), pair.privateKey).toString(
    'base64url',
  ),
});
const results: Record<string, boolean> = {};
for (const [name, value] of [
  ['valid', signed],
  ['tampered', { ...signed, payload: payload.replace(accountId, `0x${'11'.repeat(20)}`) }],
] as const) {
  const response = await fetch('https://rpc.mainnet.near.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: name,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: 'intents.near',
        method_name: 'simulate_intents',
        args_base64: Buffer.from(JSON.stringify({ signed: [value] })).toString('base64'),
      },
    }),
  });
  const body = (await response.json()) as {
    result?: { result?: number[]; error?: string };
    error?: unknown;
  };
  if (!response.ok || body.error) throw new Error('Mainnet query failed');
  if (name === 'valid') {
    const parsed = body.result?.result
      ? (JSON.parse(Buffer.from(body.result.result).toString()) as {
          intents_executed?: unknown[];
          invariant_violated?: unknown;
        })
      : null;
    results.validAccepted = parsed?.intents_executed?.length === 1 && !parsed.invariant_violated;
  } else results.tamperedRejected = /invalid signature/.test(body.result?.error ?? '');
}
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      network: 'mainnet',
      ...results,
      broadcasts: 0,
      fundsMoved: false,
    },
    null,
    2,
  ),
);
if (!results.validAccepted || !results.tamperedRejected) process.exitCode = 1;
