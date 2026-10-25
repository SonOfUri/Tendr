import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { countdown, describeAction, usableIn } from './actions';
import type { SavedAddress, SignerKey } from './api';
import { assetInfo, formatAmount, formatUnits, parseUnits, poaTokenContract } from './assets';
import { encodeRecoveryPayload, recoveryMessage } from './recovery-payload';
import { signRecovery } from './recovery-kit';
import { approvedAtEpoch } from './proposals';

const savedAddress = (over: Partial<SavedAddress> = {}): SavedAddress => ({
  id: 'pal_1',
  chain: 'eth',
  address: '0x1111111111111111111111111111111111111111',
  status: 'active',
  activeFrom: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const USDC_LIVE = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

describe('amounts', () => {
  it('formats and parses with the asset decimals', () => {
    expect(formatUnits('1234500000', 6)).toBe('1,234.5');
    expect(formatUnits('5', 6)).toBe('0.000005');
    expect(formatUnits('0', 6)).toBe('0');
    expect(parseUnits('1,234.5', 6)).toBe('1234500000');
    expect(parseUnits('0.000001', 6)).toBe('1');
    expect(parseUnits('1.0000001', 6)).toBeNull();
    expect(parseUnits('abc', 6)).toBeNull();
    expect(parseUnits('-1', 6)).toBeNull();
  });

  it('humanises only exact registered ids of the mode; anything else stays raw with its id', () => {
    expect(assetInfo(USDC_LIVE, true)).toEqual({ symbol: 'USDC', decimals: 6, known: true });
    expect(formatAmount('nep141:usdt.tether-token.near', '2500000', true)).toBe('2.5 USDT');
    expect(formatAmount('nep141:usdc.fakes.testnet', '2500000', false)).toBe('2.5 USDC');
    // A look-alike id is not USDC: no guessed symbol or decimals, the raw amount and full id.
    for (const lookalike of ['nep141:usdc.near', 'nep141:fake-usdt.near', 'nep141:usdc.e.near']) {
      expect(assetInfo(lookalike, true)).toEqual({ symbol: lookalike, decimals: 0, known: false });
      expect(formatAmount(lookalike, '2500000', true)).toBe(
        `2500000 smallest units of ${lookalike}`,
      );
    }
    // The registry is per mode: a mainnet id is not humanised on the test account.
    expect(assetInfo(USDC_LIVE, false).known).toBe(false);
    expect(assetInfo('nep141:usdc.fakes.testnet', true).known).toBe(false);
    // Unknown assets are entered in whole smallest units.
    expect(parseUnits('2500000', assetInfo('nep141:x.near', true).decimals)).toBe('2500000');
    expect(parseUnits('2.5', assetInfo('nep141:x.near', true).decimals)).toBeNull();
  });

  it('derives the PoA token contract from the asset; never typed by hand', () => {
    expect(poaTokenContract('nep141:usdc.near')).toBe('usdc.near');
    expect(poaTokenContract('nep245:v2_1.omni.hot.tg:56_xyz')).toBeNull();
  });
});

describe('describeAction', () => {
  const ctx = { savedAddresses: [savedAddress()], members: [], livemode: true };

  it('a withdrawal shows the full destination address and chain, not a nickname', () => {
    const s = describeAction(
      {
        withdraw: {
          asset: USDC_LIVE,
          amount: '25000000',
          saved_address_id: 'pal_1',
          route: { poa: { token_contract: 'usdc.near' } },
        },
      },
      ctx,
    );
    expect(s.title).toBe('Withdraw 25 USDC');
    expect(s.destination).toEqual({
      chain: 'eth',
      address: '0x1111111111111111111111111111111111111111',
    });
    expect(s.warnings).toEqual([]);
  });

  it('a swap withdrawal names the deposit account as the real destination', () => {
    const s = describeAction(
      {
        withdraw: {
          asset: 'nep141:usdc.near',
          amount: '1',
          saved_address_id: 'pal_1',
          route: { swap: { deposit_account: 'deposit-abc.near' } },
        },
      },
      ctx,
    );
    expect(s.destination).toMatchObject({ chain: 'near', address: 'deposit-abc.near' });
    expect(s.destination?.note).toContain('0x1111111111111111111111111111111111111111');
    expect(s.warnings.join(' ')).toMatch(/swap deposit account/);
  });

  it('an unknown saved address is a warning, never a silent label', () => {
    const s = describeAction(
      {
        withdraw: {
          asset: 'nep141:usdc.near',
          amount: '1',
          saved_address_id: 'pal_unknown',
          route: { poa: { token_contract: 'usdc.near' } },
        },
      },
      ctx,
    );
    expect(s.destination).toBeNull();
    expect(s.warnings[0]).toMatch(/not in this store's list/);
  });

  it('refunds and new saved addresses carry their own destination', () => {
    expect(
      describeAction(
        {
          refund: {
            asset: 'nep141:usdc.near',
            amount: '1000000',
            destination_chain: 'base',
            destination: '0xabc',
            payment_id: 'pay_1',
            route: { poa: { token_contract: 'usdc.near' } },
          },
        },
        ctx,
      ).destination,
    ).toEqual({ chain: 'base', address: '0xabc' });
    expect(
      describeAction({ add_saved_address: { id: 'pal_2', chain: 'near', address: 'me.near' } }, ctx)
        .destination,
    ).toEqual({ chain: 'near', address: 'me.near' });
    expect(describeAction({ set_threshold: 2 }, ctx).title).toBe('Require 2 approvals');
  });

  it('countdown', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(countdown('2026-01-01T05:03:00Z', now)).toBe('5h 03m');
    expect(countdown('2026-01-01T00:00:30Z', now)).toBe('1m');
    expect(countdown('2025-12-31T00:00:00Z', now)).toBe('ready');
    // A saved address added just now (active 24 h after execution).
    expect(usableIn('2026-01-01T23:59:59Z', now)).toBe('usable in 24h');
    expect(usableIn('2025-12-31T00:00:00Z', now)).toBe('usable now');
  });
});

describe('recovery payload', () => {
  const v = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../onchain/merchant-account/test-vectors/recovery-payloads.json',
      ),
      'utf8',
    ),
  ) as {
    contract_id: string;
    new_signers: { id: string; keys: SignerKey[] }[];
    new_threshold: number;
    nonce: string;
    recovery_key_epoch: string;
    valid_until: string;
    payload_borsh_hex: string;
    message_hex: string;
    signature_b64: string;
  };
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const input = {
    contractId: v.contract_id,
    newSigners: v.new_signers,
    newThreshold: v.new_threshold,
    nonce: BigInt(v.nonce),
    recoveryKeyEpoch: BigInt(v.recovery_key_epoch),
    validUntil: BigInt(v.valid_until),
  };

  it('matches the Rust vectors byte for byte, and the kit signature verifies', () => {
    expect(hex(encodeRecoveryPayload(input))).toBe(v.payload_borsh_hex);
    const message = recoveryMessage(input);
    expect(hex(message)).toBe(v.message_hex);
    const seed = new Uint8Array(32).fill(9);
    expect(signRecovery(seed, message)).toBe(v.signature_b64);
    expect(
      ed25519.verify(
        Uint8Array.from(Buffer.from(v.signature_b64, 'base64')),
        message,
        ed25519.getPublicKey(seed),
      ),
    ).toBe(true);
  });
});

describe('approvedAtEpoch', () => {
  const p = {
    approvals: [
      { userId: 'per_a', signerEpoch: '3', txHash: null, approvedAt: '2026-01-01T00:00:00Z' },
    ],
  };
  it('an approval from an older signer epoch no longer counts (approve again)', () => {
    expect(approvedAtEpoch(p, 'per_a', '3')).toBe(true);
    expect(approvedAtEpoch(p, 'per_a', '4')).toBe(false);
    expect(approvedAtEpoch(p, 'per_b', '3')).toBe(false);
    expect(approvedAtEpoch(p, 'per_a', null)).toBe(true);
  });
});
