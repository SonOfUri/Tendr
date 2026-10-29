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
import {
  buildEvmSweepTx,
  type SweepChain,
  type SweepOutcome,
  type SweepToken,
} from './fee-sweep-chains.js';
import { sweepKeyAddress, transferCalldata, type SignedSweep } from './fee-sweep-guard.js';
import {
  FEE_SWEEP_DESTINATION_ASSET,
  FEE_SWEEP_FAILED,
  FEE_SWEEP_NEEDS_GAS,
  FEE_SWEEP_UNKNOWN_FAIL_MS,
  FEE_SWEEP_WAITING,
  executeSweep,
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
const FEE_RESERVE = 10n ** 15n; // 0.001 ETH: one token sweep's fee
/** A native sweep leaves gas for 3 token sweeps plus its own transfer (R12-k). */
const NATIVE_RESERVE = 4n * FEE_RESERVE;

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
  /** Runs while the transfer is built (a slow transport, a concurrent executor). */
  onBuild: () => Promise<void> = async () => {};
  /** What the chain says about a sent transfer (default: it landed and is confirmed). */
  landed: SweepOutcome = 'confirmed';
  /** Makes the broadcast call fail after the transfer went out (a timeout, a lost answer). */
  broadcastError: Error | null = null;
  outcomes: string[] = [];
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
  async nativeReserve() {
    return NATIVE_RESERVE;
  }
  async build(_c: string, _a: string, t: SweepToken, to: string, amount: bigint) {
    await this.onBuild();
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
  /** Lands the transfer: the native coin pays its value and its gas. */
  async broadcast(_c: string, s: SignedSweep) {
    this.broadcasts.push(s);
    const t = Transaction.from(s.signed);
    this.native -= t.value + t.gasLimit * t.maxFeePerGas!;
    if (t.data !== '0x') this.balances.set(USDC, 0n);
    if (this.broadcastError) throw this.broadcastError;
  }
  async outcome(_c: string, txHash: string): Promise<SweepOutcome> {
    this.outcomes.push(txHash);
    return this.broadcasts.some((b) => b.txHash === txHash) ? this.landed : 'unknown';
  }
}

class FakeOneClick implements Partial<OneClickProvider> {
  quotes: QuoteRequest[] = [];
  deposits: string[] = [];
  /** USDC out per USD in (1 = a fair route). */
  rate = 1;
  fail: Error | null = null;
  async quote(req: QuoteRequest) {
    this.quotes.push(req);
    if (this.fail) throw this.fail;
    const priced = LIST.get(req.originAsset)!;
    const usdIn = (Number(req.amount) / 10 ** priced.decimals) * Number(priced.priceUsd);
    const usdcOut = Math.floor(usdIn * this.rate * 1e6);
    return {
      quote: {
        depositAddress: DEPOSIT,
        amountIn: req.amount,
        amountInUsd: usdIn.toFixed(6),
        amountOut: String(usdcOut),
        amountOutUsd: (usdcOut / 1e6).toFixed(6),
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
    chain.native = 10n ** 16n + NATIVE_RESERVE; // 0.01 ETH ($25) above the reserve
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

  it('a native sweep keeps the gas reserve, and a balance at or below it plans nothing', async () => {
    chain.native = NATIVE_RESERVE;
    expect(await planFeeSweeps(true, NOW)).toEqual([]);
  });

  it('a native coin is swept only on the threshold rule, never weekly (R12-k)', async () => {
    chain.native = NATIVE_RESERVE + 2n * 10n ** 15n; // $5 above the reserve, never swept
    expect(await planFeeSweeps(true, NOW)).toEqual([]);
    chain.native = NATIVE_RESERVE + 8n * 10n ** 15n; // $20 above it
    const plans = await planFeeSweeps(true, NOW);
    expect(plans.map((p) => [p.token.symbol, p.reason, p.amount])).toEqual([
      ['ETH', 'threshold', 8n * 10n ** 15n],
    ]);
  });

  it('the weekly rule skips dust below $1', async () => {
    chain.native = 0n;
    chain.balances.set(USDC, 999_999n);
    expect(await planFeeSweeps(true, NOW)).toEqual([]);
    chain.balances.set(USDC, 1_000_000n);
    expect((await planFeeSweeps(true, NOW)).map((p) => p.reason)).toEqual(['weekly']);
  });

  it('a failed attempt backs off 6 h before the token is planned again', async () => {
    chain.native = 0n;
    chain.balances.set(USDC, 50_000_000n);
    await prisma.feeSweep.create({
      data: {
        id: 'fsw_recentfail',
        livemode: true,
        family: 'evm',
        chain: 'base',
        accountAddress: account,
        assetId: USDC,
        symbol: 'USDC',
        amount: 1,
        amountUsd: 1,
        reason: 'threshold',
        status: 'failed',
        failedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
      },
    });
    expect(await planFeeSweeps(true, NOW)).toEqual([]);
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect((await planFeeSweeps(true, later)).map((p) => p.token.symbol)).toEqual(['USDC']);
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
    chain.native = 10n ** 16n + NATIVE_RESERVE;
    const r = await runFeeSweep(NOW);
    expect(r.executed).toBe(1);
    const t = Transaction.from(chain.broadcasts[0]!.signed);
    expect(t.to?.toLowerCase()).toBe(DEPOSIT);
    expect(t.value).toBe(10n ** 16n);
    expect(t.data).toBe('0x');
  });

  it('after a native sweep the account still has gas for the next token sweeps (R12-k)', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    await prisma.feeSweep.deleteMany({ where: { assetId: ETH } });
    chain.balances.set(USDC, 0n);
    chain.native = NATIVE_RESERVE + 10n ** 16n; // $25 of native fees above the reserve
    expect((await runFeeSweep(NOW)).executed).toBe(1);
    expect(Transaction.from(chain.broadcasts[0]!.signed).value).toBe(10n ** 16n);
    expect(chain.native).toBeGreaterThanOrEqual(3n * FEE_RESERVE);
    // Three token sweeps in a row still find gas: never needs_gas.
    for (let i = 1; i <= 3; i++) {
      chain.balances.set(USDC, 25_000_000n);
      const r = await runFeeSweep(new Date(NOW.getTime() + i * DAY));
      expect(r).toMatchObject({ executed: 1, needsGas: 0 });
    }
    expect(await prisma.feeSweep.count({ where: { status: 'needs_gas' } })).toBe(0);
  });

  it('refuses a quote paying less than 95 % of the plan after slippage: nothing signed', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    oneclick.rate = 0.95; // 0.95 × 0.99 slippage < 0.95
    const r = await runFeeSweep(NOW);
    expect(r).toMatchObject({ executed: 0, failed: 1 });
    expect(chain.built).toHaveLength(0);
    expect(chain.broadcasts).toHaveLength(0);
    const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
    expect(row.lastError).toMatch(/pays too little/);
    expect(row.failedAt).toEqual(NOW);
    // 0.97 × 0.99 ≥ 0.95: accepted (after the 6 h back-off).
    oneclick.rate = 0.97;
    const later = await runFeeSweep(new Date(NOW.getTime() + 6 * 60 * 60_000));
    expect(later.executed).toBe(1);
  });

  it('failure notices are throttled per account and token, not per account', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    await prisma.feeSweep.deleteMany({ where: { assetId: ETH } });
    chain.native = NATIVE_RESERVE + 10n ** 16n;
    oneclick.fail = new Error('1Click down');
    const r = await runFeeSweep(NOW);
    expect(r.failed).toBe(2);
    const ev = await prisma.event.findMany({ where: { type: FEE_SWEEP_FAILED } });
    expect(ev).toHaveLength(2);
    expect(ev.some((e) => e.aggregateId.endsWith(`:${ETH}`))).toBe(true);
    expect(ev.some((e) => e.aggregateId.endsWith(`:${USDC}`))).toBe(true);
  });

  it('an execution past its time budget fails before signing; nothing is sent', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    setFeeSweepDeps({
      chains: () => [chain],
      tokens: async () => LIST,
      oneclick: () => oneclick as unknown as OneClickProvider,
      executeMs: 50,
    });
    chain.onBuild = () => new Promise((done) => setTimeout(done, 150));
    const r = await runFeeSweep(NOW);
    expect(r).toMatchObject({ executed: 0, failed: 1 });
    expect(chain.broadcasts).toHaveLength(0);
    const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
    expect(row.lastError).toMatch(/time budget/);
    expect(row.txHash).toBeNull();
  });

  it('a plan whose lease was taken over during execution is not broadcast, nor overwritten', async () => {
    setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    const takeover = new Date(NOW.getTime() + 99 * 60_000);
    chain.onBuild = async () => {
      await prisma.feeSweep.updateMany({
        where: { assetId: USDC },
        data: { leaseUntil: takeover },
      });
    };
    const r = await runFeeSweep(NOW);
    expect(r.failed).toBe(0);
    expect(chain.broadcasts).toHaveLength(0);
    // The catch path is lease-conditional: the other executor's plan is left as it holds it.
    const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
    expect(row).toMatchObject({ status: 'planned', leaseUntil: takeover, lastError: null });
    expect(row.txHash).toBeNull();
    expect(await events(FEE_SWEEP_FAILED)).toBe(0);
  });

  describe('executed only once confirmed on chain (final review m2)', () => {
    beforeEach(() => {
      setEnv({ FEE_SWEEP_ENABLED: 'true', TENDR_FEE_ACCOUNT_NEAR: 'fees.tendr.near' });
    });

    it('a pending transfer stays broadcast and blocks re-planning until it confirms', async () => {
      chain.landed = 'pending';
      const r = await runFeeSweep(NOW);
      expect(r).toMatchObject({ executed: 0, broadcast: 1 });
      let row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
      expect(row).toMatchObject({ status: 'broadcast', broadcastAt: NOW, executedAt: null });
      expect(row.txHash).toBe(chain.broadcasts[0]!.txHash);

      // An hour later the balance looks the same (the transfer is still pending): no second
      // plan, nothing quoted or sent.
      chain.balances.set(USDC, 30_000_000n);
      const later = await runFeeSweep(new Date(NOW.getTime() + 60 * 60_000));
      expect(later).toMatchObject({ planned: 0, broadcast: 0 });
      expect(oneclick.quotes).toHaveLength(1);
      expect(chain.broadcasts).toHaveLength(1);

      // It confirms: the next run reconciles it by hash.
      chain.landed = 'confirmed';
      chain.balances.set(USDC, 0n);
      const done = await runFeeSweep(new Date(NOW.getTime() + 2 * 60 * 60_000));
      expect(done.executed).toBe(1);
      row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
      expect(row.status).toBe('executed');
      expect(row.executedAt).toEqual(new Date(NOW.getTime() + 2 * 60 * 60_000));
    });

    it('a transfer that failed on chain is failed (and notified), never executed', async () => {
      chain.landed = 'failed';
      const r = await runFeeSweep(NOW);
      expect(r).toMatchObject({ executed: 0, failed: 1 });
      const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
      expect(row).toMatchObject({ status: 'failed', failedAt: NOW, executedAt: null });
      expect(row.lastError).toMatch(/failed on chain/);
      expect(await events(FEE_SWEEP_FAILED)).toBe(1);
    });

    it('a transfer the node never knew is failed only after FEE_SWEEP_UNKNOWN_FAIL_MS', async () => {
      chain.landed = 'unknown';
      await runFeeSweep(NOW);
      let row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
      expect(row.status).toBe('broadcast');
      await runFeeSweep(new Date(NOW.getTime() + FEE_SWEEP_UNKNOWN_FAIL_MS - 1));
      row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
      expect(row.status).toBe('broadcast');
      await runFeeSweep(new Date(NOW.getTime() + FEE_SWEEP_UNKNOWN_FAIL_MS));
      row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
      expect(row.status).toBe('failed');
      expect(row.lastError).toMatch(/never landed/);
    });

    it('a broadcast timeout after the hash was recorded is reconciled on chain, not failed (Task 12)', async () => {
      chain.broadcastError = new Error('fee sweep: execution exceeded its time budget');
      chain.landed = 'confirmed';
      const r = await runFeeSweep(NOW);
      expect(r).toMatchObject({ executed: 1, failed: 0 });
      expect(chain.outcomes).toEqual([chain.broadcasts[0]!.txHash]);
      const row = await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } });
      expect(row).toMatchObject({ status: 'executed', failedAt: null });
      expect(await events(FEE_SWEEP_FAILED)).toBe(0);

      // Still unknown at once: stays broadcast (reconciled later), never failed meanwhile.
      await prisma.feeSweep.deleteMany();
      chain.balances.set(USDC, 30_000_000n);
      chain.landed = 'pending';
      const pending = await runFeeSweep(new Date(NOW.getTime() + DAY));
      expect(pending).toMatchObject({ broadcast: 1, failed: 0 });
      expect((await prisma.feeSweep.findFirstOrThrow({ where: { assetId: USDC } })).status).toBe(
        'broadcast',
      );
    });

    it('no transport for the family: failed with failedAt (it backs off)', async () => {
      const [plan] = await planFeeSweeps(true, NOW);
      setFeeSweepDeps({
        chains: () => [],
        tokens: async () => LIST,
        oneclick: () => oneclick as unknown as OneClickProvider,
      });
      expect(await executeSweep(plan!, NOW)).toBe('failed');
      const row = await prisma.feeSweep.findUniqueOrThrow({ where: { id: plan!.id } });
      expect(row).toMatchObject({ status: 'failed', failedAt: NOW });
      expect(row.lastError).toMatch(/no transport/);
    });
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
        'broadcastAt',
        'chain',
        'createdAt',
        'depositAddress',
        'destinationAsset',
        'executedAt',
        'failedAt',
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
