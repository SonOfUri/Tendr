// Argument parsing, refusals, the spend cap and the confirmation prompt of the checkout mainnet
// verification script. Nothing here touches a network: only the pure parts are exercised.
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { UsageError } from './lib/near-script.js';
import {
  CONFIRM_FLAG,
  CONFIRM_WORD,
  MAX_SPEND_USD,
  SpendTracker,
  assertPlanWithinCap,
  buildSpendPlan,
  cleanupCommand,
  confirmSpend,
  parseVerifyArgs,
  splitUnderpay,
  overpayAmount,
  summarizeCredits,
} from './verify-checkout-mainnet.js';

const KEY = (() => {
  const seed = new Uint8Array(32).fill(7);
  return `ed25519:${bs58.encode(Buffer.concat([seed, ed25519.getPublicKey(seed)]))}`;
})();
const ENV = {
  VERIFY_FUNDER_ACCOUNT_ID: 'me.near',
  VERIFY_FUNDER_PRIVATE_KEY: KEY,
  ONECLICK_API_KEY: 'jwt',
  VERIFY_CHAINALYSIS_API_KEY: 'ck',
};
const OK = [`--${CONFIRM_FLAG}`];

describe('checkout:verify:mainnet argument parsing', () => {
  it('refuses without the exact confirmation flag and says it spends mainnet funds', () => {
    for (const argv of [
      [],
      ['--yes'],
      ['--yes-i-understand'],
      ['--yes-i-understand-this-spends-funds'],
      ['--YES-I-UNDERSTAND-THIS-SPENDS-MAINNET-FUNDS'],
    ]) {
      expect(() => parseVerifyArgs(argv, ENV)).toThrow(UsageError);
    }
    expect(() => parseVerifyArgs([], ENV)).toThrow(
      /--yes-i-understand-this-spends-mainnet-funds[\s\S]*MAINNET funds[\s\S]*5 USD/,
    );
    // A value on the flag is refused too (it is a plain switch).
    expect(() => parseVerifyArgs([`--${CONFIRM_FLAG}=yes`], ENV)).toThrow(/takes no value/);
  });

  it('refuses unknown flags and stray arguments', () => {
    expect(() => parseVerifyArgs([...OK, '--force'], ENV)).toThrow(/unknown argument/);
    expect(() => parseVerifyArgs([...OK, 'run'], ENV)).toThrow(/unknown argument/);
  });

  it('refuses a missing or testnet funder account and a malformed key', () => {
    expect(() => parseVerifyArgs(OK, { ...ENV, VERIFY_FUNDER_ACCOUNT_ID: undefined })).toThrow(
      /VERIFY_FUNDER_ACCOUNT_ID/,
    );
    expect(() => parseVerifyArgs(OK, { ...ENV, VERIFY_FUNDER_PRIVATE_KEY: undefined })).toThrow(
      /VERIFY_FUNDER_PRIVATE_KEY/,
    );
    expect(() => parseVerifyArgs(OK, { ...ENV, VERIFY_FUNDER_ACCOUNT_ID: 'me.testnet' })).toThrow(
      /testnet/,
    );
    expect(() => parseVerifyArgs(OK, { ...ENV, VERIFY_FUNDER_PRIVATE_KEY: 'not-a-key' })).toThrow(
      /ed25519/,
    );
    // The refusal never echoes the key.
    try {
      parseVerifyArgs(OK, { ...ENV, VERIFY_FUNDER_PRIVATE_KEY: 'ed25519:abc0' });
    } catch (err) {
      expect((err as Error).message).not.toContain('abc0');
    }
  });

  it('refuses a testnet RPC or 1Click URL', () => {
    expect(() =>
      parseVerifyArgs(OK, { ...ENV, NEAR_RPC_URL_LIVE: 'https://rpc.testnet.near.org' }),
    ).toThrow(/looks like testnet/);
    expect(() =>
      parseVerifyArgs(OK, { ...ENV, ONECLICK_BASE_URL: 'https://1click-testnet.example' }),
    ).toThrow(/looks like testnet/);
  });

  it('a run needs the 1Click JWT and the Chainalysis key; cleanup needs neither', () => {
    expect(() => parseVerifyArgs(OK, { ...ENV, ONECLICK_API_KEY: undefined })).toThrow(
      /ONECLICK_API_KEY/,
    );
    expect(() => parseVerifyArgs(OK, { ...ENV, VERIFY_CHAINALYSIS_API_KEY: '' })).toThrow(
      /VERIFY_CHAINALYSIS_API_KEY/,
    );
    const c = parseVerifyArgs([...OK, '--phase', 'cleanup'], {
      VERIFY_FUNDER_ACCOUNT_ID: 'me.near',
      VERIFY_FUNDER_PRIVATE_KEY: KEY,
    });
    expect(c.phase).toBe('cleanup');
  });

  it('refuses a wrong phase', () => {
    for (const phase of ['prepare', 'finish', 'all', 'RUN', '']) {
      expect(() => parseVerifyArgs([...OK, '--phase', phase], ENV)).toThrow(/--phase/);
    }
    expect(() => parseVerifyArgs([...OK, '--phase'], ENV)).toThrow(/needs a value/);
  });

  it('refuses a bad amount, non-nep141 assets, identical assets and a bad fee setup', () => {
    expect(() => parseVerifyArgs([...OK, '--amount', '0'], ENV)).toThrow(/--amount/);
    expect(() => parseVerifyArgs([...OK, '--amount', '1.5'], ENV)).toThrow(/--amount/);
    expect(() => parseVerifyArgs([...OK, '--origin-asset', 'usdt.tether-token.near'], ENV)).toThrow(
      /nep141/,
    );
    expect(() =>
      parseVerifyArgs(
        [...OK, '--origin-asset', 'nep141:usdc.near', '--destination-asset', 'nep141:usdc.near'],
        ENV,
      ),
    ).toThrow(/differ/);
    expect(() => parseVerifyArgs([...OK, '--fee-bps', '0'], ENV)).toThrow(/--fee-bps/);
    expect(() => parseVerifyArgs([...OK, '--fee-bps', '10001'], ENV)).toThrow(/--fee-bps/);
    expect(() => parseVerifyArgs([...OK, '--fee-account', 'me.near'], ENV)).toThrow(
      /fee account must not be the funder/,
    );
    expect(() => parseVerifyArgs([...OK, '--fee-account', 'Bad Account'], ENV)).toThrow(
      /--fee-account/,
    );
  });

  it('accepts a confirmed run with defaults (1 USDC out per payment, 50 bps to fees.tendr.near)', () => {
    const a = parseVerifyArgs(OK, ENV);
    expect(a.phase).toBe('run');
    expect(a.amountOut).toBe('1000000');
    expect(a.feeBps).toBe(50);
    expect(a.feeAccount).toBe('fees.tendr.near');
    expect(a.originAsset).toBe('nep141:usdt.tether-token.near');
    expect(a.destAsset).toBe(
      'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    );
    expect(a.rpcUrl).toBe('https://rpc.mainnet.near.org');
    expect(a.oneClickUrl).toBe('https://1click.chaindefuser.com');
    expect(parseVerifyArgs(OK, { ...ENV, FEE_ACCOUNT_LIVE: 'fees.other.near' }).feeAccount).toBe(
      'fees.other.near',
    );
  });
});

describe('spend cap', () => {
  it('is 5 USD and refuses a plan above it or without a price', () => {
    expect(MAX_SPEND_USD).toBe(5);
    expect(assertPlanWithinCap(4.99)).toBeCloseTo(4.99);
    expect(assertPlanWithinCap(5)).toBe(5);
    expect(() => assertPlanWithinCap(5.01)).toThrow(/above the 5 USD cap/);
    expect(() => assertPlanWithinCap(Number.NaN)).toThrow(/cannot be priced/);
    expect(() => assertPlanWithinCap(-1)).toThrow(/cannot be priced/);
  });

  it('prices every payment and the NEAR costs, and refuses an oversized amount', () => {
    const plan = buildSpendPlan({
      amountInUsd: '1.01',
      amountIn: '1010000',
      originAsset: 'nep141:usdt.tether-token.near',
      nearUsd: '3',
    });
    expect(plan.text).toMatch(/overpay.*1\.2625 USD/);
    expect(plan.text).toMatch(/underpay \+ top-up.*1\.01 USD/);
    expect(plan.text).toMatch(/late deposit.*1\.01 USD/);
    expect(plan.text).toMatch(/NEAR storage and gas/);
    expect(plan.totalUsd).toBeGreaterThan(3.28);
    expect(plan.totalUsd).toBeLessThan(5);
    expect(plan.originUnits).toBe(1262500n + 1010000n + 1010000n);
    expect(() => assertPlanWithinCap(plan.totalUsd)).not.toThrow();

    const big = buildSpendPlan({
      amountInUsd: '2.02',
      amountIn: '2020000',
      originAsset: 'nep141:usdt.tether-token.near',
      nearUsd: '3',
    });
    expect(() => assertPlanWithinCap(big.totalUsd)).toThrow(/above the 5 USD cap/);
  });

  it('refuses a plan whose price inputs are missing', () => {
    expect(() =>
      buildSpendPlan({ amountInUsd: undefined, amountIn: '1', originAsset: 'x', nearUsd: '3' }),
    ).toThrow(/amountInUsd/);
    expect(() =>
      buildSpendPlan({ amountInUsd: '1', amountIn: '1', originAsset: 'x', nearUsd: undefined }),
    ).toThrow(/NEAR price/);
  });

  it('the running tracker refuses any send that would pass the cap', () => {
    const t = new SpendTracker(0.2);
    t.commit(1.3, 'overpay');
    t.commit(1.1, 'top-up');
    expect(t.totalUsd).toBeCloseTo(2.6);
    expect(() => t.commit(2.5, 'late')).toThrow(/refusing to send late/);
    expect(t.totalUsd).toBeCloseTo(2.6);
    expect(() => t.commit(Number.NaN, 'x')).toThrow(/cannot be priced/);
  });
});

describe('confirmation prompt', () => {
  it('goes ahead only on the exact word', async () => {
    for (const [answer, ok] of [
      [CONFIRM_WORD, true],
      [`  ${CONFIRM_WORD}\n`, true],
      ['yes', false],
      ['y', false],
      ['', false],
      [CONFIRM_WORD.toUpperCase(), false],
    ] as const) {
      const asked: string[] = [];
      const go = await confirmSpend(3.4, async (q) => {
        asked.push(q);
        return answer;
      });
      expect(go).toBe(ok);
      expect(asked[0]).toContain('3.40 USD');
    }
  });
});

describe('helpers', () => {
  it('splits an underpay and sizes an overpay', () => {
    expect(splitUnderpay(1_000_001n)).toEqual({ first: 500_000n, rest: 500_001n });
    expect(overpayAmount(1_000_000n)).toBe(1_250_000n);
  });

  it('summarises credits for the exact-output check', () => {
    expect(summarizeCredits([{ amount: 1000n }], 1000n)).toEqual({ verdict: 'exact', best: 1000n });
    expect(summarizeCredits([{ amount: 900n }, { amount: 1200n }], 1000n)).toEqual({
      verdict: 'more',
      best: 1200n,
    });
    expect(summarizeCredits([{ amount: 900n }], 1000n)).toEqual({ verdict: 'short', best: 900n });
    expect(summarizeCredits([], 1000n)).toEqual({ verdict: 'none', best: 0n });
  });

  it('prints the exact cleanup command', () => {
    expect(cleanupCommand()).toBe(
      'npm run checkout:verify:mainnet --workspace=@tendr/api -- --yes-i-understand-this-spends-mainnet-funds --phase cleanup',
    );
  });
});
