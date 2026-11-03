import { describe, expect, it } from 'vitest';
import { nativePasskeyStep } from './native-passkey';

describe('native wallet console ceremonies', () => {
  it('registers a dedicated credential and then signs activation, without sending it automatically', () => {
    expect(
      nativePasskeyStep('/v1/account/native/passkey/options', { challenge: 'c' }),
    ).toMatchObject({ kind: 'register', target: '/v1/account/native/passkey/verify' });
    const data = {
      options: { challenge: 'c', allowCredentials: [{ id: 'wallet', type: 'public-key' }] },
    };
    for (const path of ['/v1/account/native/passkey/verify', '/v1/account/native/activate/options'])
      expect(nativePasskeyStep(path, data)).toMatchObject({
        kind: 'authenticate',
        target: '/v1/account/native/activate',
      });
    expect(nativePasskeyStep('/v1/account/native/payouts/npay_1/challenge', data)).toMatchObject({
      target: '/v1/account/native/payouts/npay_1/submit',
    });
    expect(nativePasskeyStep('/v1/account/native/payouts', data)).toBeNull();
    expect(
      nativePasskeyStep('/v1/account/native/payouts/npay_1/challenge', { options: {} }),
    ).toBeNull();
  });
});
