// Gas-fee sweep (Task 12): planning rules, the operator gate, the recipient gate, gas for the
// transfer, the sweep records, and that only a transfer to the quote's deposit address is signed.
// Fake transports and a fake 1Click: nothing reaches a network (ruling R12-g).
import { Transaction } from 'ethers';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneClickProvider, QuoteRequest, TokenInfo } from '../checkout/oneclick/index.js';
import { loadEnv } from '../env.js';
import { getKeyVault } from '../keyvault/index.js';
import { prisma } from '../lib/prisma.js';
import { resetDb } from '../test/helpers.js';
import { buildEvmSweepTx, type SweepChain, type SweepToken } from './fee-sweep-chains.js';
import { sweepKeyAddress, transferCalldata, type SignedSweep } from './fee-sweep-guard.js';
import {
  FEE_SWEEP_DESTINATION_ASSET,
  FEE_SWEEP_FAILED,
  FEE_SWEEP_NEEDS_GAS,
  FEE_SWEEP_WAITING,
  planFeeSweeps,
  runFeeSweep,
  setFeeSweepDeps,
  usdValue,
} from './fee-sweep.js';

const USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDC_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ETH = 'nep141:base.omft.near';
const DEPOSIT = '0x' + '44'.repeat(20);
const EVIL = '0x' + '66'.repeat(20);
const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = 86_400_000;
const FEE_RESERVE = 10n ** 15n; // 0.001 ETH

const LIST = new Map<string, TokenInfo>([
  [USDC, { assetId: USDC, blockchain: 'base', symbol: 'USDC', decimals: 6, priceUsd: '1' }],
  [ETH, { assetId: ETH, blockchain: 'base', symbol: 'ETH', decimals: 18, priceUsd: '2500' }],
]);

class FakeChain implements SweepChain {
  readonly family = 'evm' as const;
  balances = new Map<string, bigint>();
  native = 10n ** 17n;
  built: string[] = [];
  broadcasts: SignedSweep[] = [];
  /** Overrides the transfer the transport builds (a compromised transport). */
  recipientOverride: string | null = null;
  chains() {
    return ['base'];
  }
  tokens(): SweepToken[] {
    return [
      { assetId: USDC, symbol: 'USDC', decimals: 6, contract: USDC_ADDR },
      { assetId: ETH, symbol: 'ETH', decimals: 18, contract: null },
    ];
  }
  async balance(_c: string, _a: string, t: SweepToken) {
    return t.contract === null ? this.native : (this.balances.get(t.assetId) ?? 0n);
  }
  async nativeBalance() {
    return this.native;
  }
  async transferFee() {
    return FEE_RESERVE;
  }
  async build(_c: string, _a: string, t: SweepToken, to: string, amount: bigint) {
    this.built.push(to);
    return buildEvmSweepTx({
      chain: 'base',
      nonce: 0,
      token: t.contract,
      to: this.recipientOverride ?? to,
      amount,
      gasLimit: 100_000n,
      maxFeePerGas: 2n * 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 8n,
    });
  }
  async broadcast(_c: string, s: SignedSweep) {
    this.broadcasts.push(s);
  }
}

class FakeOneClick implements Partial<OneClickProvider> {
  quotes: QuoteRequest[] = [];
  deposits: string[] = [];
  async quote(req: QuoteRequest) {
    this.quotes.push(req);
    return {
      quote: {
        depositAddress: DEPOSIT,
        amountIn: req.amount,
        amountInUsd: '0',
        amountOut: '0',
        amountOutUsd: '0',
      },
      correlationId: `corr-${this.quotes.length}`,
    };
  }
  async submitDeposit(txHash: string) {
    this.deposits.push(txHash);
  }
}

let chain: FakeChain;
let oneclick: FakeOneClick;
let account: string;

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  loadEnv();
}

const events = (type: string) => prisma.event.count({ where: { type } });

async function executedSweep(assetId: string, at: Date) {
  await prisma.feeSweep.create({
    data: {
      id: `fsw_${Math.random().toString(36).slice(2)}`,
      livemode: true,
      family: 'evm',
      chain: 'base',
      accountAddress: account,
      assetId,
      symbol: 'X',
      amount: 1,
      amountUsd: 1,
      reason: 'threshold',
      status: 'executed',
      executedAt: at,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  chain = new FakeChain();
  oneclick = new FakeOneClick();
  setFeeSweepDeps({
    chains: () => [chain],
    tokens: async () => LIST,
    oneclick: () => oneclick as unknown as OneClickProvider,
  });
  account = await sweepKeyAddress(getKeyVault(), 'evm');
  setEnv({
    FEE_SWEEP_ENABLED: undefined,
    TENDR_FEE_ACCOUNT_NEAR: undefined,
    FEE_SWEEP_THRESHOLD_USD: undefined,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  setFeeSweepDeps(null);
  setEnv({ FEE_SWEEP_ENABLED: undefined, TENDR_FEE_ACCOUNT_NEAR: undefined });
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('planFeeSweeps', () => {
  it('plans nothing in test mode and records nothing (R12-a)', async () => {
    chain.balances.set(USDC, 100_000_000n);
    expect(await planFeeSweeps(false, NOW)).toEqual([]);
    expect(await prisma.feeSweep.count()).toBe(0);
  });

  it('below the threshold and swept within 7 days: no plan', async () => {
    chain.balances.set(USDC, 5_000_000n); // $5
    chain.native = 0n;
    await executedSweep(USDC, new Date(NOW.getTime() - 6 * DAY));
    expect(await planFeeSweeps(true, NOW)).toEqual([]);
    expect(await prisma.feeSweep.count({ where: { status: 'planned' } })).toBe(0);
  });

  it('below the threshold but last swept 7 days ago (or never): a weekly plan', async () => {
    chain.balances.set(USDC, 5_000_000n);
    chain.native = 0n;
    await executedSweep(USDC, new Date(NOW.getTime() - 7 * DAY));
    const plans = await planFeeSweeps(true, NOW);
    expect(plans.map((p) => [p.token.assetId, p.reason])).toEqual([[USDC, 'weekly']]);
  });

  it('the 7-day rule reads the last executed sweep, not a failed one', async () => {
    chain.balances.set(USDC, 5_000_000n);
    chain.native = 0n;
    await executedSweep(USDC, new Date(NOW.getTime() - 2 * DAY));
    await prisma.feeSweep.create({
      data: {
        id: 'fsw_failedone',
        livemode: true,
        family: 'evm',
        chain: 'base',
        accountAddress: account,
        assetId: USDC,
        symbol: 'USDC',
        amount: 1,
        amountUsd: 1,
        reason: 'weekly',
        status: 'failed',
        createdAt: new Date(NOW.getTime() - 9 * DAY),
      },
    });
    expect(await planFeeSweeps(true, NOW)).toEqual([]);
  });

  it('at or above the threshold: one plan per token, recorded once (one open plan)', async () => {
    await executedSweep(USDC, new Date(NOW.getTime() - DAY));
    await executedSweep(ETH, new Date(NOW.getTime() - DAY));
    chain.balances.set(USDC, 20_000_000n); // exactly $20
    chain.native = 10n ** 16n + FEE_RESERVE; // 0.01 ETH ($25) after the reserve
    const plans = await planFeeSweeps(true, NOW);
    expect(plans.map((p) => [p.token.symbol, p.reason, p.amount, p.amountUsd])).toEqual([
      ['USDC', 'threshold', 20_000_000n, '20'],
      ['ETH', 'threshold', 10n ** 16n, '25'],
    ]);
    await planFeeSweeps(true, NOW);
    const rows = await prisma.feeSweep.findMany({ where: { status: 'planned' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.accountAddress)).toEqual([account, account]);
  });

  it('a native sweep keeps the fee reserve, and a balance below it plans nothing', async () => {
    chain.native = FEE_RESERVE;
    expect(await planFeeSweeps(true, NOW)).toEqual([]);
  });

  it('values tokens at the token-list price, rounded down to the micro-dollar', () => {
    expect(usdValue(1_234_567n, 6, '1')).toBe('1.234567');
    expect(usdValue(10n ** 18n + 1n, 18, '2500.5')).toBe('2500.5');
    expect(usdValue(1n, 18, '2500')).toBe('0');
  });
});

describe('runFeeSweep', () => {
  beforeEach(() => {
    chain.balances.set(USDC, 30_000_000n);
    chain.native = 2n * FEE_RESERVE; // enough gas, but its own sweep is under $20 and recent
  });
  beforeEach(async () => {
    await executedSweep(ETH, new Date(NOW.getTime() - DAY));
  });

  it('gate off (default): nothing is quoted or signed; operators get one notice (6 h)', async () => {
    const r = await runFeeSweep(NOW);
    expect(r).toMatchObject({ planned: 1, executed: 0, held: 'disabled' });
    expect(oneclick.quotes).toHaveLength(0);
    expect(chain.built).toHaveLength(0);
    expect(chain.broadcasts).toHaveLength(0);
    expect(await events(FEE_SWEEP_WAITING)).toBe(1);
    await runFeeSweep(new Date(NOW.getTime() + 60 * 60_000));
    expect(await events(FEE_SWEEP_WAITING)).toBe(1);
    await runFeeSweep(new Date(NOW.getTime() + 6 * 60 * 60_000));
    expect(await events(FEE_SWEEP_WAITING)).toBe(2);
    expect(await prisma.feeSweep.count({ where: { status: 'planned' } })).toBe(1);
  });

  it('gate on without TENDR_FEE_ACCOUNT_NEAR: nothing executes; the notice says why', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true' });
    const r = await runFeeSweep(NOW);
    expect(r.held).toBe('no_recipient');
    expect(chain.broadcasts).toHaveLength(0);
    const ev = await prisma.event.findFirst({ where: { type: FEE_SWEEP_WAITING } });
    expect(JSON.stringify(ev?.payload)).toContain('TENDR_FEE_ACCOUNT_NEAR');
  });

  it('gate on: quotes USDC on NEAR to the fee account and signs only the transfer to the deposit address', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    const r = await runFeeSweep(NOW);
    expect(r).toMatchObject({ planned: 1, executed: 1, failed: 0, held: null });
    expect(oneclick.quotes).toHaveLength(1);
    expect(oneclick.quotes[0]).toMatchObject({
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: USDC,
      destinationAsset: FEE_SWEEP_DESTINATION_ASSET,
      amount: '30000000',
      recipient: 'fees.tendr.near',
      recipientType: 'DESTINATION_CHAIN',
      refundTo: account,
      refundType: 'ORIGIN_CHAIN',
    });
    expect(chain.broadcasts).toHaveLength(1);
    const t = Transaction.from(chain.broadcasts[0]!.signed);
    expect(t.from?.toLowerCase()).toBe(account.toLowerCase());
    expect(t.to?.toLowerCase()).toBe(USDC_ADDR);
    expect(t.value).toBe(0n);
    expect(t.data).toBe(transferCalldata(DEPOSIT, 30_000_000n));
    const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
    expect(row).toMatchObject({
      status: 'executed',
      quoteId: 'corr-1',
      depositAddress: DEPOSIT,
      destinationAsset: FEE_SWEEP_DESTINATION_ASSET,
      recipient: 'fees.tendr.near',
      txHash: t.hash,
      executedAt: NOW,
      leaseUntil: null,
    });
    expect(row.amountUsd.toFixed()).toBe('30');
    expect(oneclick.deposits).toEqual([t.hash]);
    // Executed: the next run within 7 days plans nothing below the threshold.
    chain.balances.set(USDC, 1_000_000n);
    expect(await planFeeSweeps(true, new Date(NOW.getTime() + DAY))).toEqual([]);
  });

  it('a transport that builds a transfer to another address is refused: nothing signed or sent', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    chain.recipientOverride = EVIL;
    const r = await runFeeSweep(NOW);
    expect(r).toMatchObject({ executed: 0, failed: 1 });
    expect(chain.broadcasts).toHaveLength(0);
    const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
    expect(row.status).toBe('failed');
    expect(row.txHash).toBeNull();
    expect(row.lastError).toMatch(/refuses to sign/);
    expect(await events(FEE_SWEEP_FAILED)).toBe(1);
  });

  it('a token sweep without native gas: needs_gas, no quote, one notice per account per 6 h', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    chain.native = FEE_RESERVE - 1n;
    const r = await runFeeSweep(NOW);
    expect(r).toMatchObject({ needsGas: 1, executed: 0 });
    expect(oneclick.quotes).toHaveLength(0);
    expect(chain.built).toHaveLength(0);
    expect((await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } })).status).toBe(
      'needs_gas',
    );
    expect(await events(FEE_SWEEP_NEEDS_GAS)).toBe(1);
    await runFeeSweep(new Date(NOW.getTime() + 5 * 60 * 60_000));
    expect(await events(FEE_SWEEP_NEEDS_GAS)).toBe(1);
    // Still one open row (needs_gas is the open plan), refreshed.
    expect(await prisma.feeSweep.count({ where: { assetId: USDC } })).toBe(1);
    // Once the account has gas, the same plan executes.
    chain.native = 2n * FEE_RESERVE;
    const later = await runFeeSweep(new Date(NOW.getTime() + 6 * 60 * 60_000));
    expect(later.executed).toBe(1);
    expect(await prisma.feeSweep.count({ where: { assetId: USDC, status: 'executed' } })).toBe(1);
  });

  it('a native sweep sends the balance less the reserve', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    chain.balances.set(USDC, 0n);
    await prisma.feeSweep.deleteMany({ where: { assetId: ETH } });
    chain.native = 10n ** 16n + FEE_RESERVE;
    const r = await runFeeSweep(NOW);
    expect(r.executed).toBe(1);
    const t = Transaction.from(chain.broadcasts[0]!.signed);
    expect(t.to?.toLowerCase()).toBe(DEPOSIT);
    expect(t.value).toBe(10n ** 16n);
    expect(t.data).toBe('0x');
  });

  it('records no key material or signed bytes (R12-f)', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    await runFeeSweep(NOW);
    const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
    expect(Object.keys(row).sort()).toEqual(
      [
        'accountAddress',
        'amount',
        'amountUsd',
        'assetId',
        'chain',
        'createdAt',
        'depositAddress',
        'destinationAsset',
        'executedAt',
        'family',
        'id',
        'lastError',
        'leaseUntil',
        'livemode',
        'quoteId',
        'reason',
        'recipient',
        'status',
        'symbol',
        'txHash',
        'updatedAt',
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toContain(chain.broadcasts[0]!.signed.slice(2, 60));
  });
});
