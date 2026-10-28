// Gasless Tron USDT through the TendrForwarder (two signatures: an exact-amount `approve`, then a
// TIP-712 `TendrPayment`), with just-in-time energy delegated by `gas-tron` (rulings T9-a … T9-e).
// The live path runs against a scripted Tron HTTP API (never a real node) on test-mode sessions
// (quotes from the 1Click simulator); the test-mode flow runs end to end through the routes with no
// Tron call at all.
import { secp256k1 } from '@noble/curves/secp256k1';
import type { Merchant } from '@prisma/client';
import {
  TENDR_PAYMENT_TYPES,
  TEST_PAYMENT_DOMAIN_NAME,
  TEST_TRON_REF_BLOCK,
  TEST_VERIFYING_CONTRACT,
} from '@tendr/contracts';
import { Wallet } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { pollDeposit, registerWatcherHooks } from '../checkout/watcher.js';
import { scopedDb } from '../db/scoped.js';
import { loadEnv } from '../env.js';
import { putGasPolicy } from '../gas/policy.js';
import { getKeyVault } from '../keyvault/index.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';
import { gaslessQuote, resetRelayers } from './index.js';
import { TronCallReverted } from './tron-rpc.js';
import type { BroadcastResult, TronApi, TronBlock, TronResources, TronTxInfo } from './tron-rpc.js';
import {
  approveData,
  decodeApprove,
  decodeRaw,
  decodeSignedTx,
  encodeRaw,
  evmToTron,
  FORWARDER,
  recoverSigner,
  tronAddressOfPublicKey,
  tronToEvm,
  txIdOf,
  type TronRaw,
} from './tron-tx.js';
import {
  TRON_APPROVE_KIND,
  TRON_CHAIN_IDS,
  TRON_EXPIRY_CONFIRM_MS,
  TRON_GASLESS_TOKENS,
  TRON_PAYMENT_KIND,
  TRON_RECLAIM_AFTER_MS,
  TronGasless,
  pollTronRelays,
  resetTronRelayer,
} from './tron.js';
import { sendApprove, tronGasFeeAddress } from './tron-energy.js';

const sim1click = isolatedSimStore();
const USDC = 'nep141:usdc.test'; // settlement asset (NEAR intents)
const TOKEN = TRON_GASLESS_TOKENS[0]!;
const USDT = TOKEN.contract;
const TRX = 'nep141:tron.omft.near';
const FORWARDER_ADDRESS = evmToTron('0x' + '7a'.repeat(20));
const ENERGY_PER_TRX = 10n; // 180e9 energy / 18e9 TRX staked network-wide
const APPROVE_ENERGY = 45_000n;
const PRICE = 210n; // sun per energy

/** A scripted Tron HTTP API: accounts, resources, USDT, the forwarder and gas-tron's stake. */
class FakeTron implements TronApi {
  calls: string[] = [];
  height = 70_000_000n;
  clock: () => number = () => Date.now();
  accounts = new Set<string>();
  own = new Map<string, Partial<TronResources>>();
  /** `${receiver}/${resource}` → sun delegated by gas-tron. */
  delegated = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  usedNonces = new Set<string>();
  gasTron = '';
  sent: { txId: string; raw: TronRaw; hex: string; signer: string | null }[] = [];
  /** Fullnode and solidified infos (a mined transaction shows in both unless `solidLag`). */
  infos = new Map<string, TronTxInfo>();
  solidLag = false;
  /** Kinds mined as soon as they are broadcast. */
  mine = { delegate: true, undelegate: true, approve: true, pay: true };
  approveFails = false;
  /** The approve simulation (`triggerconstantcontract`) reverts. */
  approveReverts = false;
  /** Answers for the next broadcasts, in order (undefined: the normal answer). */
  broadcastResults: (BroadcastResult | undefined)[] = [];
  down: string | null = null;

  private hit(name: string) {
    this.calls.push(name);
    if (this.down === name) throw new Error('socket hang up');
  }

  async nowBlock(solid: boolean): Promise<TronBlock> {
    this.hit(solid ? 'solid-block' : 'block');
    const n = this.height;
    return {
      id: n.toString(16).padStart(16, '0') + 'ab'.repeat(24),
      number: n,
      timestamp: this.clock() - (solid ? 60_000 : 0),
    };
  }
  async accountExists(address: string) {
    this.hit('getaccount');
    return this.accounts.has(address);
  }
  async resources(address: string): Promise<TronResources> {
    this.hit('getaccountresource');
    const o = this.own.get(address) ?? {};
    const energy = ((this.delegated.get(`${address}/energy`) ?? 0n) / 1_000_000n) * ENERGY_PER_TRX;
    const bw = ((this.delegated.get(`${address}/bandwidth`) ?? 0n) / 1_000_000n) * 2n;
    return {
      freeNetLimit: o.freeNetLimit ?? 600n,
      freeNetUsed: o.freeNetUsed ?? 0n,
      netLimit: (o.netLimit ?? 0n) + bw,
      netUsed: o.netUsed ?? 0n,
      energyLimit: (o.energyLimit ?? 0n) + energy,
      energyUsed: o.energyUsed ?? 0n,
      totalEnergyLimit: 180_000_000_000n,
      totalEnergyWeight: 18_000_000_000n,
      totalNetLimit: 43_200_000_000n,
      totalNetWeight: 21_600_000_000n,
    };
  }
  async canDelegateMaxSun() {
    this.hit('getcandelegatedmaxsize');
    return 1_000_000_000_000n;
  }
  async delegatedSun(_from: string, to: string, resource: 'energy' | 'bandwidth') {
    this.hit('getdelegatedresourcev2');
    return this.delegated.get(`${to}/${resource}`) ?? 0n;
  }
  async constantCall(owner: string, contract: string, selector: string, parameter: string) {
    this.hit(`call:${selector}`);
    const word = (i: number) => parameter.slice(i * 64, i * 64 + 64);
    const addr = (i: number) => evmToTron('0x' + word(i).slice(24));
    const out = (v: bigint) => v.toString(16).padStart(64, '0');
    if (selector === 'approve(address,uint256)') {
      if (this.approveReverts) throw new TronCallReverted('REVERT opcode executed');
      return { result: out(1n), energyUsed: APPROVE_ENERGY };
    }
    if (selector === 'allowance(address,address)' && contract === USDT) {
      return { result: out(this.allowances.get(addr(0)) ?? 0n), energyUsed: 0n };
    }
    if (selector === 'balanceOf(address)' && contract === USDT) {
      return { result: out(this.balances.get(addr(0)) ?? 0n), energyUsed: 0n };
    }
    if (selector === 'nonceUsed(address,bytes32)' && contract === FORWARDER_ADDRESS) {
      return {
        result: out(this.usedNonces.has(`${addr(0)}/0x${word(1)}`) ? 1n : 0n),
        energyUsed: 0n,
      };
    }
    throw new Error(`unexpected call ${selector} on ${contract} from ${owner}`);
  }
  async energyPrice() {
    this.hit('getchainparameters');
    return PRICE;
  }
  async broadcastHex(hex: string): Promise<BroadcastResult> {
    this.hit('broadcasthex');
    const { raw, signature } = decodeSignedTx(hex);
    const tx = decodeRaw(raw);
    const txId = txIdOf(raw);
    this.sent.push({ txId, raw: tx, hex, signer: recoverSigner(txId, signature) });
    const injected = this.broadcastResults.length ? this.broadcastResults.shift() : undefined;
    if (injected) return injected;
    if (this.infos.has(txId)) return { ok: false, code: 'DUP_TRANSACTION_ERROR', message: '' };
    this.execute(txId, tx);
    return { ok: true };
  }
  async txInfo(txId: string, solid: boolean) {
    this.hit(solid ? 'solid-info' : 'info');
    if (solid && this.solidLag) return null;
    return this.infos.get(txId) ?? null;
  }

  info(txId: string, over: Partial<TronTxInfo> = {}): TronTxInfo {
    return {
      id: txId,
      blockNumber: Number(this.height),
      blockTimeStamp: this.clock(),
      fee: 0n,
      result: null,
      receiptResult: null,
      energyUsage: 0n,
      energyFee: 0n,
      netUsage: 280n,
      netFee: 0n,
      logs: [],
      ...over,
    };
  }

  /** Executes a broadcast transaction, when its kind is set to mine. */
  execute(txId: string, tx: TronRaw) {
    const c = tx.contract;
    if (c.type !== 'trigger') {
      const k = `${c.receiver}/${c.resource}`;
      const have = this.delegated.get(k) ?? 0n;
      if (c.type === 'delegate') {
        if (!this.mine.delegate) return;
        this.delegated.set(k, have + c.balance);
        this.infos.set(txId, this.info(txId));
        return;
      }
      if (!this.mine.undelegate) return;
      if (have < c.balance) {
        this.infos.set(txId, this.info(txId, { result: 'FAILED' }));
        return;
      }
      this.delegated.set(k, have - c.balance);
      this.infos.set(txId, this.info(txId));
      return;
    }
    if (c.contract === USDT) {
      if (!this.mine.approve) return;
      const a = decodeApprove(c.data)!;
      if (this.approveFails) {
        this.infos.set(
          txId,
          this.info(txId, { result: 'FAILED', receiptResult: 'REVERT', energyUsage: 20_000n }),
        );
        return;
      }
      this.allowances.set(c.owner, a.value);
      this.infos.set(
        txId,
        this.info(txId, { receiptResult: 'SUCCESS', energyUsage: APPROVE_ENERGY, netUsage: 345n }),
      );
    } else if (c.contract === FORWARDER_ADDRESS) {
      if (!this.mine.pay) return;
      const d = FORWARDER.decodeFunctionData(
        'payWithApproval',
        `0x${Buffer.from(c.data).toString('hex')}`,
      );
      const p = d[0] as {
        token: string;
        from: string;
        to: string;
        amount: bigint;
        fee: bigint;
        feeTo: string;
        nonce: string;
      };
      const from = evmToTron(p.from);
      const allowance = this.allowances.get(from) ?? 0n;
      const key = `${from}/${p.nonce.toLowerCase()}`;
      if (allowance < p.amount + p.fee || this.usedNonces.has(key)) {
        this.infos.set(
          txId,
          this.info(txId, { result: 'FAILED', receiptResult: 'REVERT', energyUsage: 30_000n }),
        );
        return;
      }
      this.usedNonces.add(key);
      this.allowances.set(from, allowance - p.amount - p.fee);
      const ev = FORWARDER.encodeEventLog(FORWARDER.getEvent('TendrPaid')!, [
        p.from,
        p.token,
        p.to,
        p.amount,
        p.fee,
        p.nonce,
      ]);
      this.infos.set(
        txId,
        this.info(txId, {
          receiptResult: 'SUCCESS',
          energyUsage: 110_000n,
          fee: 270_000n,
          netFee: 270_000n,
          logs: [
            {
              address: tronToEvm(FORWARDER_ADDRESS).slice(2),
              topics: ev.topics.map((t) => t.slice(2)),
              data: ev.data.slice(2),
            },
          ],
        }),
      );
    }
  }

  ofType(type: 'delegate' | 'undelegate') {
    return this.sent.filter((s) => s.raw.contract.type === type);
  }
  calls_to(contract: string) {
    return this.sent.filter(
      (s) => s.raw.contract.type === 'trigger' && s.raw.contract.contract === contract,
    );
  }
}

interface ApproveTd {
  transaction: {
    txID: string;
    raw_data_hex: string;
    raw_data: { ref_block_bytes: string; ref_block_hash: string };
  };
  owner: string;
  token: string;
  spender: string;
  value: string;
  fee_limit: string;
  expiration: string;
}

interface PaymentTd {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, string>;
}

describe('Tron gasless payments (approve + TendrPayment, just-in-time energy)', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let priv: Uint8Array;
  let WALLET: string;
  let chain: FakeTron;
  let relayer: TronGasless;
  let gasTron: string;
  let feeAddress: string;
  let clock: number;

  const newWallet = () => {
    priv = secp256k1.utils.randomPrivateKey();
    WALLET = tronAddressOfPublicKey(secp256k1.getPublicKey(priv, false));
    chain.accounts.add(WALLET);
    chain.balances.set(WALLET, 10_000_000_000n);
  };

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    resetTronRelayer();
    process.env.TRON_FORWARDER_ADDRESS = FORWARDER_ADDRESS;
    loadEnv();
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Bean Shop', defaultGasPayer: 'merchant' });
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      destAssetId: USDC,
      destChain: 'near',
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    await putGasPolicy(
      { merchantId: merchant.id, livemode: false, actor: { by: 'api_key', apiKeyId: 'key_x' } },
      { enabled: true },
    );
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    clock = Date.now();
    chain = new FakeTron();
    chain.clock = () => clock;
    gasTron = tronAddressOfPublicKey((await getKeyVault().publicKey('gas-tron')).raw);
    feeAddress = tronAddressOfPublicKey((await getKeyVault().publicKey('gas-fees-tron')).raw);
    chain.gasTron = gasTron;
    newWallet();
    relayer = new TronGasless(true, {
      api: chain,
      now: () => new Date(clock),
      sleep: async () => {},
    });
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    delete process.env.TRON_FORWARDER_ADDRESS;
    loadEnv();
    resetTokenCache();
    resetOneClickProviders();
    resetRelayers();
  });
  afterAll(async () => {
    await sim1click.clear();
    await prisma.$disconnect();
  });

  const call = (method: 'GET' | 'POST', path: string, secretKey: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/v1/checkout/client/${path}`,
      headers: { authorization: `Bearer ${secretKey}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  async function newSession(gasPayer?: 'shopper') {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${testKey}` },
      payload: {
        // Large enough that the merchant may sponsor (the fee is capped at 1% of the order).
        amount: '200.00',
        amount_currency: 'USD',
        external_ref: `order-${Math.random().toString(36).slice(2)}`,
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
        ...(gasPayer ? { gas_payer: gasPayer } : {}),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; client_secret: string };
  }

  /** A `forwarder` quote for the wallet; the merchant sponsors unless `shopper`. */
  async function tronQuote(gasPayer?: 'shopper', wallet = WALLET) {
    const s = await newSession(gasPayer);
    const qr = await call('POST', 'quote', s.client_secret, {
      origin_asset: TOKEN.assetId,
      wallet_address: wallet,
      gasless_method: 'forwarder',
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: qr.json().id } });
    const scope = { merchantId: merchant.id, livemode: false };
    const ctx = { ...scope, db: scopedDb(scope), sessionId: s.id };
    const { q } = await gaslessQuote(ctx, quote.id);
    return { s, ctx, quote, q };
  }
  type TQuote = Awaited<ReturnType<typeof tronQuote>>;

  /** Re-reads the quote context (the session's status may have changed). */
  const refresh = async (p: TQuote) => ({ ...p, q: (await gaslessQuote(p.ctx, p.quote.id)).q });

  /** What TronLink's `trx.sign` does to the prepared transaction: sign its txID as is. */
  function signApprove(
    td: ApproveTd,
    over: { mutate?: (r: TronRaw) => TronRaw; key?: Uint8Array } = {},
  ) {
    let raw = Buffer.from(td.transaction.raw_data_hex, 'hex');
    if (over.mutate) raw = Buffer.from(encodeRaw(over.mutate(decodeRaw(raw))));
    const id = txIdOf(raw);
    const sig = secp256k1.sign(Buffer.from(id, 'hex'), over.key ?? priv);
    return {
      rawDataHex: raw.toString('hex'),
      signature: Buffer.from([...sig.toCompactRawBytes(), sig.recovery + 27]).toString('hex'),
    };
  }

  async function signPayment(td: PaymentTd, message?: Record<string, string>, key = priv) {
    const w = new Wallet(Buffer.from(key).toString('hex'));
    return w.signTypedData(td.domain, TENDR_PAYMENT_TYPES, message ?? td.message);
  }

  const prepare = (p: TQuote) => relayer.prepare(p.q, {});
  const approveTd = async (p: TQuote) => {
    const payload = await prepare(p);
    expect(payload.step).toBe('approve');
    return payload.to_sign[0]!.typed_data as ApproveTd;
  };
  const submitApprove = (p: TQuote, signed: { rawDataHex: string; signature: string }) =>
    relayer.submit(p.q, { signatures: {}, tronApprove: signed });
  const submitPayment = (p: TQuote, td: PaymentTd, signature: string, message = td.message) =>
    relayer.submit(p.q, { signatures: { [TRON_PAYMENT_KIND]: { message, signature } } });

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (err) {
      if (err instanceof AppError) return err;
      throw err;
    }
    throw new Error('expected a refusal');
  }

  const pollAt = (at: number) =>
    pollTronRelays({ api: chain, livemode: false, now: () => new Date(at) });

  /** What Tendr has recorded as its own Tron cost (USD), provisional rows included. */
  const tendrUsd = async () =>
    (
      await prisma.gasSponsorship.aggregate({
        where: { sponsor: 'tendr' },
        _sum: { costUsd: true },
      })
    )._sum.costUsd?.toFixed() ?? '0';
  /** USD of `sun` at the simulator's TRX price ($0.25), rounded up to micro-USD. */
  const usdOf = (sun: bigint) => {
    const micro = (sun * 25n + 99n) / 100n;
    return (Number(micro) / 1e6).toString();
  };

  /** Prepares, signs and submits the approve, then lets the poller confirm it (solidified). */
  async function approved(p: TQuote) {
    const td = await approveTd(p);
    const res = await submitApprove(p, signApprove(td));
    await pollAt(clock);
    return { td, res };
  }

  async function paymentTd(p: TQuote) {
    const payload = await prepare(p);
    expect(payload.step).toBe('payment');
    expect(payload.to_sign[0]!.kind).toBe(TRON_PAYMENT_KIND);
    return payload.to_sign[0]!.typed_data as PaymentTd;
  }

  it('offers USDT only, and nothing without a forwarder or for an unactivated account', async () => {
    const s = await newSession();
    const session = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    const scope = { merchantId: merchant.id, livemode: false };
    const opts = (asset: string, wallet = WALLET) =>
      relayer.options({
        shopper: { ...scope, db: scopedDb(scope), sessionId: s.id },
        session,
        origin: {
          assetId: asset,
          blockchain: 'tron',
          symbol: asset === TRX ? 'TRX' : 'USDT',
          decimals: 6,
          priceUsd: '1',
        },
        walletAddress: wallet,
      });
    expect(await opts(TOKEN.assetId)).toEqual([
      { method: 'forwarder', paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null },
    ]);
    expect(await opts(TRX)).toEqual([]);
    const stranger = evmToTron('0x' + '99'.repeat(20));
    expect(await opts(TOKEN.assetId, stranger)).toEqual([
      {
        method: 'forwarder',
        paid_by: 'shopper',
        reason: null,
        fee_modes: [],
        token_fee: null,
        unavailable_reason: 'tron_account_not_activated',
      },
    ]);
    delete process.env.TRON_FORWARDER_ADDRESS;
    loadEnv();
    expect(await opts(TOKEN.assetId)).toEqual([]);
    // A forwarder quote for TRX is refused at quote time.
    const qr = await call('POST', 'quote', s.client_secret, {
      origin_asset: TRX,
      wallet_address: WALLET,
      gasless_method: 'forwarder',
    });
    expect(qr.statusCode, qr.body).toBe(400);
  });

  it('approve → just-in-time energy → TendrPayment → payWithApproval once → reclaimed', async () => {
    const p = await tronQuote();
    expect(p.quote.networkFeePaidBy).toBe('merchant');
    const amount = BigInt(p.quote.amountIn.toFixed(0));

    // Step 1: the exact approve, built by Tendr; preparing spends nothing.
    const payload = await prepare(p);
    expect(payload).toMatchObject({
      quote_id: p.quote.id,
      method: 'forwarder',
      chain: 'tron',
      chain_id: TRON_CHAIN_IDS.live,
      signer: WALLET,
      step: 'approve',
      amount: amount.toString(),
      fee_amount: '0',
    });
    expect(payload.to_sign[0]!.kind).toBe(TRON_APPROVE_KIND);
    const td = payload.to_sign[0]!.typed_data as ApproveTd;
    expect(td).toMatchObject({
      owner: WALLET,
      token: USDT,
      spender: FORWARDER_ADDRESS,
      value: amount.toString(),
    });
    const raw = decodeRaw(Buffer.from(td.transaction.raw_data_hex, 'hex'));
    expect(td.transaction.txID).toBe(txIdOf(Buffer.from(td.transaction.raw_data_hex, 'hex')));
    expect(raw.contract).toMatchObject({ type: 'trigger', owner: WALLET, contract: USDT });
    expect(decodeApprove((raw.contract as { data: Uint8Array }).data)).toEqual({
      spender: FORWARDER_ADDRESS,
      value: amount,
    });
    expect(Number(raw.expiration)).toBeLessThanOrEqual(p.quote.deadline.getTime());
    await prepare(p);
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.tronDelegation.count()).toBe(0);

    // The signed approve comes back to Tendr: checked, then energy, then the approve itself.
    const signed = signApprove(td);
    const res = await submitApprove(p, signed);
    expect(res).toMatchObject({
      status: 'submitted',
      txHash: td.transaction.txID,
      step: 'approve',
    });
    expect(chain.sent.map((s) => s.raw.contract.type)).toEqual(['delegate', 'trigger']);
    const del = chain.sent[0]!;
    expect(del.signer).toBe(gasTron);
    // Just enough energy for one approve (the estimate + 20 %), in staked TRX.
    const need = (APPROVE_ENERGY * 12n) / 10n;
    expect(del.raw.contract).toEqual({
      type: 'delegate',
      owner: gasTron,
      receiver: WALLET,
      resource: 'energy',
      balance: ((need + ENERGY_PER_TRX - 1n) / ENERGY_PER_TRX) * 1_000_000n,
    });
    // The approve is broadcast exactly as the shopper signed it.
    expect(chain.sent[1]!.txId).toBe(td.transaction.txID);
    expect(chain.sent[1]!.signer).toBe(WALLET);
    const approval = await prisma.tronApproval.findFirstOrThrow({ where: { quoteId: p.quote.id } });
    expect(approval).toMatchObject({
      wallet: WALLET,
      txId: td.transaction.txID,
      status: 'submitted',
    });
    expect(await prisma.tronDelegation.findMany({ where: { approvalId: approval.id } })).toEqual([
      expect.objectContaining({
        resource: 'energy',
        receiver: WALLET,
        status: 'delegated',
        delegateTxId: del.txId,
      }),
    ]);
    // While the approve is in flight: no second approve, no second delegation.
    expect((await refusal(prepare(p))).code).toBe('CONFLICT');
    expect((await refusal(submitApprove(p, signed))).code).toBe('CONFLICT');
    expect(chain.ofType('delegate')).toHaveLength(1);

    // The poller confirms the approve and reclaims the delegation at once.
    await pollAt(clock);
    expect(
      await prisma.tronApproval.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({ status: 'confirmed', energyUsed: APPROVE_ENERGY });
    const und = chain.ofType('undelegate');
    expect(und).toHaveLength(1);
    expect(und[0]!.raw.contract).toMatchObject({
      owner: gasTron,
      receiver: WALLET,
      resource: 'energy',
      balance: (del.raw.contract as { balance: bigint }).balance,
    });
    await pollAt(clock);
    expect(
      await prisma.tronDelegation.findFirstOrThrow({ where: { approvalId: approval.id } }),
    ).toMatchObject({ status: 'reclaimed' });

    // Step 2: the TIP-712 TendrPayment for exactly this quote.
    const ptd = await paymentTd(p);
    expect(ptd.domain).toEqual({
      name: 'TendrForwarder',
      version: '1',
      chainId: TRON_CHAIN_IDS.live,
      verifyingContract: tronToEvm(FORWARDER_ADDRESS),
    });
    expect(ptd.message).toMatchObject({
      token: tronToEvm(USDT),
      from: tronToEvm(WALLET),
      to: tronToEvm(p.quote.depositAddress),
      amount: amount.toString(),
      fee: '0',
      deadline: Math.floor(p.quote.deadline.getTime() / 1000).toString(),
    });
    const sig = await signPayment(ptd);
    const sub = await submitPayment(p, ptd, sig);
    const pays = chain.calls_to(FORWARDER_ADDRESS);
    expect(pays).toHaveLength(1);
    expect(pays[0]!.signer).toBe(gasTron);
    expect(sub).toEqual({
      submissionId: p.quote.gasSponsorshipId,
      txHash: pays[0]!.txId,
      status: 'submitted',
      step: 'payment',
    });
    const d = FORWARDER.decodeFunctionData(
      'payWithApproval',
      `0x${Buffer.from((pays[0]!.raw.contract as { data: Uint8Array }).data).toString('hex')}`,
    );
    expect((d[0] as { to: string }).to.toLowerCase()).toBe(tronToEvm(p.quote.depositAddress));
    expect(d[1]).toBe(sig);
    // The repeat submit returns the same submission; nothing more is sent.
    expect((await submitPayment(p, ptd, sig)).submissionId).toBe(p.quote.gasSponsorshipId);
    expect(chain.calls_to(FORWARDER_ADDRESS)).toHaveLength(1);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: p.quote.gasSponsorshipId! },
    });
    expect(sp).toMatchObject({
      method: 'forwarder',
      provider: 'gas-tron',
      status: 'submitted',
      txHash: pays[0]!.txId,
    });

    // The outcome: confirmed; the cost includes the approve's delegated energy.
    await pollAt(clock);
    const done = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } });
    expect(done.status).toBe('confirmed');
    // payWithApproval: 110k energy + 0.27 TRX burned; the approve: 45k delegated energy.
    const sun = 110_000n * PRICE + 270_000n + APPROVE_ENERGY * PRICE;
    expect(done.costUsd?.toFixed()).toBe(
      ((Number(sun) / 1e6) * 0.25).toFixed(6).replace(/0+$/, ''),
    );
    const closed = await prisma.tronApproval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(closed.costBookedTo).toBe(sp.id);
    await pollAt(clock);
    expect(
      (await prisma.tronApproval.findUniqueOrThrow({ where: { id: approval.id } })).closedAt,
    ).not.toBeNull();
    expect(await tendrUsd()).toBe('0');
    // Further passes (or a restarted worker) send nothing more.
    await pollAt(clock + TRON_RECLAIM_AFTER_MS);
    expect(chain.ofType('delegate')).toHaveLength(1);
    expect(chain.ofType('undelegate')).toHaveLength(1);
    expect(chain.calls_to(FORWARDER_ADDRESS)).toHaveLength(1);
  });

  it('a delegation the node refuses: no approve is sent, the approval fails, a retry may follow', async () => {
    // The shopper needs bandwidth too: after the energy delegation is refused nothing else is sent.
    chain.own.set(WALLET, { freeNetUsed: 600n });
    const p = await tronQuote();
    const td = await approveTd(p);
    chain.broadcastResults = [{ ok: false, code: 'CONTRACT_VALIDATE_ERROR', message: 'no stake' }];
    const err = await refusal(submitApprove(p, signApprove(td)));
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(chain.sent.map((x) => x.raw.contract.type)).toEqual(['delegate']);
    expect(await prisma.tronApproval.findFirstOrThrow()).toMatchObject({ status: 'failed' });
    expect(await prisma.tronDelegation.findFirstOrThrow()).toMatchObject({ status: 'failed' });
    await pollAt(clock);
    expect(chain.sent).toHaveLength(1);
    expect((await prisma.tronApproval.findFirstOrThrow()).closedAt).not.toBeNull();
    // Nothing was lent: no cost.
    expect(await tendrUsd()).toBe('0');
    const res = await submitApprove(p, signApprove(td));
    expect(res.status).toBe('submitted');
    expect(chain.ofType('delegate')).toHaveLength(3);
  });

  it('an approve the node refuses: 409, its energy reclaimed (and counted) before another', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    chain.broadcastResults = [undefined, { ok: false, code: 'TAPOS_ERROR', message: 'ref block' }];
    const err = await refusal(submitApprove(p, signApprove(td)));
    expect(err.code).toBe('GASLESS_SUBMIT_FAILED');
    expect(await prisma.tronApproval.findFirstOrThrow()).toMatchObject({ status: 'failed' });
    // Its delegation is still out: no second one until it is reclaimed.
    await getRedis().del(`tendr:gasless:submit:ses:${p.s.id}`);
    const again = await refusal(submitApprove(p, signApprove(td)));
    expect(again.details).toMatchObject({ reason: 'tron_delegation_active' });
    expect(chain.ofType('delegate')).toHaveLength(1);
    await pollAt(clock);
    await pollAt(clock);
    expect(await prisma.tronDelegation.findFirstOrThrow()).toMatchObject({ status: 'reclaimed' });
    // Counted at its maximum (all lent) the moment it was lent; settled at close to what the
    // receiver actually consumed, measured before the reclaim (nothing here).
    const d = await prisma.tronDelegation.findFirstOrThrow();
    expect(d).toMatchObject({ energyUsedBefore: 0n, energyUsedAfter: 0n });
    const tendr = await prisma.gasSponsorship.findFirstOrThrow({ where: { sponsor: 'tendr' } });
    expect(tendr.paymasterData).toMatchObject({ sun: '0' });
    expect(tendr.costUsd?.toFixed()).toBe('0');
    expect((await submitApprove(p, signApprove(td))).status).toBe('submitted');
    expect(chain.ofType('delegate')).toHaveLength(2);
  });

  it('answers pending while the delegation lands; the energy job then sends the approve once', async () => {
    chain.mine.delegate = false;
    const p = await tronQuote();
    const td = await approveTd(p);
    const res = await submitApprove(p, signApprove(td));
    expect(res).toMatchObject({ status: 'pending', step: 'approve' });
    expect(await relayer.status(res.submissionId)).toBe('pending');
    expect(chain.sent.map((x) => x.raw.contract.type)).toEqual(['delegate']);
    await pollAt(clock);
    // Still landing: the same delegation is re-sent, never a second one, and no approve yet.
    expect(chain.calls_to(USDT)).toHaveLength(0);
    expect(new Set(chain.ofType('delegate').map((x) => x.txId)).size).toBe(1);
    chain.mine.delegate = true;
    const del = chain.ofType('delegate')[0]!;
    chain.execute(del.txId, del.raw);
    await pollAt(clock);
    expect(chain.calls_to(USDT)).toHaveLength(1);
    expect(chain.calls_to(USDT)[0]!.txId).toBe(td.transaction.txID);
    expect(await relayer.status(res.submissionId)).toBe('confirmed');
  });

  it('lends bandwidth too when the shopper has none left, and reclaims both', async () => {
    chain.own.set(WALLET, { freeNetUsed: 600n });
    const p = await tronQuote();
    const td = await approveTd(p);
    await submitApprove(p, signApprove(td));
    const lent = chain
      .ofType('delegate')
      .map((x) => x.raw.contract as { resource: string; balance: bigint });
    expect(lent.map((x) => x.resource)).toEqual(['energy', 'bandwidth']);
    // Just enough bytes for the approve (raw + overhead), at 2 bytes per TRX here.
    const bytes = BigInt(td.transaction.raw_data_hex.length / 2) + 140n;
    expect(lent[1]!.balance).toBe(((bytes + 1n) / 2n) * 1_000_000n);
    await pollAt(clock);
    await pollAt(clock);
    expect(chain.ofType('undelegate')).toHaveLength(2);
    expect((await prisma.tronDelegation.findMany()).map((x) => x.status)).toEqual([
      'reclaimed',
      'reclaimed',
    ]);
  });

  it('a re-quote after an approval whose payment was never issued may approve again', async () => {
    const a = await tronQuote();
    await approved(a);
    await pollAt(clock);
    const qr = await call('POST', 'quote', a.s.client_secret, {
      origin_asset: TOKEN.assetId,
      wallet_address: WALLET,
      gasless_method: 'forwarder',
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const { q: q2 } = await gaslessQuote(a.ctx, qr.json().id);
    const payload = await relayer.prepare(q2, {});
    expect(payload.step).toBe('approve');
  });

  it('refuses an approve for a closed session without delegating anything', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    await prisma.session.update({ where: { id: p.s.id }, data: { status: 'EXPIRED' } });
    const err = await refusal(submitApprove(await refresh(p), signApprove(td)));
    expect(err.code).toBe('SESSION_EXPIRED');
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.tronDelegation.count()).toBe(0);
  });

  it('refuses an approve whose value is not amount + fee, before any energy is delegated', async () => {
    const p = await tronQuote('shopper');
    expect(p.quote.networkFeePaidBy).toBe('buyer');
    const amount = BigInt(p.quote.amountIn.toFixed(0));
    const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
    const td = await approveTd(p);
    expect(td.value).toBe((amount + fee).toString());
    const withValue =
      (v: bigint) =>
      (r: TronRaw): TronRaw => ({
        ...r,
        contract: {
          ...(r.contract as Extract<TronRaw['contract'], { type: 'trigger' }>),
          data: approveData(FORWARDER_ADDRESS, v),
        },
      });
    for (const v of [amount, amount + fee + 1n, 2n ** 255n]) {
      const err = await refusal(submitApprove(p, signApprove(td, { mutate: withValue(v) })));
      expect(err.code).toBe('GASLESS_PAYLOAD_MISMATCH');
      expect(err.details).toMatchObject({ field: 'tron_approve.value' });
    }
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.tronApproval.count()).toBe(0);
  });

  it('refuses every other deviation in the approve, and a signature by anyone else', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    const trig = (r: TronRaw) => r.contract as Extract<TronRaw['contract'], { type: 'trigger' }>;
    const amount = BigInt(p.quote.amountIn.toFixed(0));
    const cases: [string, Parameters<typeof signApprove>[1]][] = [
      [
        'tron_approve.spender',
        { mutate: (r) => ({ ...r, contract: { ...trig(r), data: approveData(gasTron, amount) } }) },
      ],
      [
        'tron_approve.contract',
        { mutate: (r) => ({ ...r, contract: { ...trig(r), contract: FORWARDER_ADDRESS } }) },
      ],
      [
        'tron_approve.owner',
        { mutate: (r) => ({ ...r, contract: { ...trig(r), owner: gasTron } }) },
      ],
      [
        'tron_approve.expiration',
        { mutate: (r) => ({ ...r, expiration: BigInt(p.quote.deadline.getTime() + 1000) }) },
      ],
      ['tron_approve.fee_limit', { mutate: (r) => ({ ...r, feeLimit: r.feeLimit + 1n }) }],
      // Pinned to the issued value: a lower limit would make the approve cheap to fail.
      ['tron_approve.fee_limit', { mutate: (r) => ({ ...r, feeLimit: 1n }) }],
      [
        'tron_approve.ref_block',
        { mutate: (r) => ({ ...r, ref: { bytes: Uint8Array.from([1, 2]), hash: r.ref.hash } }) },
      ],
      ['tron_approve.signature', { key: secp256k1.utils.randomPrivateKey() }],
      // Live never accepts the test-mode TaPoS reference (ruling T10-f).
      [
        'tron_approve.ref_block',
        {
          mutate: (r) => ({
            ...r,
            ref: {
              bytes: Uint8Array.from(Buffer.from(TEST_TRON_REF_BLOCK.bytes, 'hex')),
              hash: Uint8Array.from(Buffer.from(TEST_TRON_REF_BLOCK.hash, 'hex')),
            },
          }),
        },
      ],
    ];
    for (const [field, over] of cases) {
      // Each case is a fresh attempt (the session's attempt limit counts every one).
      await getRedis().del(`tendr:gasless:submit:ses:${p.s.id}`);
      const err = await refusal(submitApprove(p, signApprove(td, over)));
      expect(err.code, field).toBe('GASLESS_PAYLOAD_MISMATCH');
      expect(err.details, field).toMatchObject({ field });
    }
    // Trailing bytes / non-canonical encodings are refused as a whole.
    await getRedis().del(`tendr:gasless:submit:ses:${p.s.id}`);
    const good = signApprove(td);
    const err = await refusal(
      submitApprove(p, { ...good, rawDataHex: `${good.rawDataHex}5201ff` }),
    );
    expect(err.details).toMatchObject({ field: 'tron_approve' });
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.tronApproval.count()).toBe(0);
  });

  it('delegates once per session: a second approve while one is in flight is refused', async () => {
    chain.mine.approve = false;
    const p = await tronQuote();
    const td = await approveTd(p);
    await submitApprove(p, signApprove(td));
    expect(chain.ofType('delegate')).toHaveLength(1);
    // A re-quote in the same session: no second delegation while the first approve may land.
    const qr = await call('POST', 'quote', p.s.client_secret, {
      origin_asset: TOKEN.assetId,
      wallet_address: WALLET,
      gasless_method: 'forwarder',
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const { q: q2 } = await gaslessQuote(p.ctx, qr.json().id);
    expect((await refusal(relayer.prepare(q2, {}))).code).toBe('CONFLICT');
    expect(chain.ofType('delegate')).toHaveLength(1);
  });

  it('reclaims after ten minutes when the approve has not landed, then once it cannot', async () => {
    chain.mine.approve = false;
    const p = await tronQuote();
    const td = await approveTd(p);
    await submitApprove(p, signApprove(td));
    await pollAt(clock + 60_000);
    expect(chain.ofType('undelegate')).toHaveLength(0);
    await pollAt(clock + TRON_RECLAIM_AFTER_MS);
    expect(chain.ofType('undelegate')).toHaveLength(1);
    await pollAt(clock + TRON_RECLAIM_AFTER_MS + 1000);
    expect(await prisma.tronDelegation.findFirstOrThrow()).toMatchObject({ status: 'reclaimed' });
    // Reclaimed, but the approve may still land: no second approve for the quote meanwhile.
    await getRedis().del(`tendr:gasless:submit:ses:${p.s.id}`);
    const again = await refusal(submitApprove(p, signApprove(td)));
    expect(again.code).toBe('CONFLICT');
    expect(again.details).toMatchObject({ step: 'approve' });
    expect(chain.ofType('delegate')).toHaveLength(1);
    // The approve never lands: past its expiration on two solidified looks, it is failed and its
    // delegated energy is Tendr's cost (the upper bound: all of it).
    const exp = decodeRaw(Buffer.from(td.transaction.raw_data_hex, 'hex')).expiration;
    clock = Number(exp) + 120_000;
    await pollAt(clock);
    await pollAt(clock + TRON_EXPIRY_CONFIRM_MS);
    const a = await prisma.tronApproval.findFirstOrThrow();
    expect(a.status).toBe('failed');
    await pollAt(clock + TRON_EXPIRY_CONFIRM_MS + 1000);
    const closed = await prisma.tronApproval.findFirstOrThrow();
    expect(closed.closedAt).not.toBeNull();
    const tendr = await prisma.gasSponsorship.findFirstOrThrow({ where: { sponsor: 'tendr' } });
    expect(tendr).toMatchObject({ chain: 'tron', method: 'forwarder', provider: 'gas-tron' });
    expect(closed.costBookedTo).toBe(`tendr:${tendr.id}`);
    expect(tendr.lossRecognizedAt).not.toBeNull();
  });

  it('refuses a TendrPayment that differs from the quote, or before the approve is confirmed', async () => {
    chain.mine.approve = false;
    const p = await tronQuote();
    const td = await approveTd(p);
    await submitApprove(p, signApprove(td));
    expect((await refusal(prepare(p))).code).toBe('CONFLICT');
    chain.mine.approve = true;
    chain.execute(td.transaction.txID, decodeRaw(Buffer.from(td.transaction.raw_data_hex, 'hex')));
    await pollAt(clock);
    const ptd = await paymentTd(p);
    const other = secp256k1.utils.randomPrivateKey();
    const changed = { ...ptd.message, amount: (BigInt(ptd.message.amount!) + 1n).toString() };
    const e1 = await refusal(submitPayment(p, ptd, await signPayment(ptd, changed), changed));
    expect(e1.details).toMatchObject({ field: 'tendr_payment.amount' });
    const e2 = await refusal(submitPayment(p, ptd, await signPayment(ptd, undefined, other)));
    expect(e2.details).toMatchObject({ field: 'tendr_payment.signer' });
    expect(chain.calls_to(FORWARDER_ADDRESS)).toHaveLength(0);
    // The allowance must cover the payment before gas-tron spends anything.
    chain.allowances.set(WALLET, 1n);
    const e3 = await refusal(submitPayment(p, ptd, await signPayment(ptd)));
    expect(e3.code).toBe('GASLESS_SUBMIT_FAILED');
    expect(chain.calls_to(FORWARDER_ADDRESS)).toHaveLength(0);
  });

  it('blocks a new approve for the wallet while an issued TendrPayment of another quote can run', async () => {
    const a = await tronQuote();
    await approved(a);
    await paymentTd(a); // issued: the shopper may have signed it
    const b = await tronQuote(); // another session, same wallet
    const err = await refusal(prepare(b));
    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ reason: 'tron_approval_in_progress' });
    // Once A's TendrPayment deadline (+ margin) has passed, B may approve (it overwrites the
    // allowance, and A's payment can no longer run).
    await prisma.tronApproval.updateMany({
      where: { quoteId: a.quote.id },
      data: { paymentDeadline: new Date(clock - 61_000) },
    });
    expect((await prepare(b)).step).toBe('approve');
  });

  it('shopper pays: approve covers amount + fee; fee revenue comes from TendrPaid', async () => {
    const p = await tronQuote('shopper');
    const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
    await approved(p);
    const ptd = await paymentTd(p);
    expect(ptd.message).toMatchObject({ fee: fee.toString(), feeTo: tronToEvm(feeAddress) });
    const sub = await submitPayment(p, ptd, await signPayment(ptd));
    await pollAt(clock);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sub.submissionId } });
    expect(sp).toMatchObject({ sponsor: 'shopper', status: 'confirmed' });
    expect(sp.feeCollected?.toFixed()).toBe(fee.toString());
  });

  it('a payment that never lands is failed after two looks past its expiration', async () => {
    const p = await tronQuote();
    await approved(p);
    const ptd = await paymentTd(p);
    chain.mine.pay = false;
    await submitPayment(p, ptd, await signPayment(ptd));
    await pollAt(clock);
    // Re-broadcast while it may still land.
    expect(chain.calls_to(FORWARDER_ADDRESS).length).toBeGreaterThanOrEqual(2);
    // The chain moves on: the solidified head passes the payment's expiration.
    clock += 5 * 60_000;
    await pollAt(clock);
    expect(
      (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: p.quote.gasSponsorshipId! } }))
        .status,
    ).toBe('submitted');
    await pollAt(clock + TRON_EXPIRY_CONFIRM_MS);
    expect(
      (await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: p.quote.gasSponsorshipId! } }))
        .status,
    ).toBe('failed');
    // The approve's cost no longer rides on it: once no payment can run any more, it is Tendr's.
    const a = await prisma.tronApproval.findFirstOrThrow();
    expect(a.costBookedTo).toBeNull();
    expect(a.closedAt).toBeNull();
    await prisma.tronApproval.update({
      where: { id: a.id },
      data: { paymentDeadline: new Date(clock - 120_000) },
    });
    await pollAt(clock + TRON_EXPIRY_CONFIRM_MS + 1000);
    const closed = await prisma.tronApproval.findFirstOrThrow();
    expect(closed.closedAt).not.toBeNull();
    const tendr = await prisma.gasSponsorship.findFirstOrThrow({ where: { sponsor: 'tendr' } });
    expect(closed.costBookedTo).toBe(`tendr:${tendr.id}`);
    expect(tendr.paymasterData).toMatchObject({ sun: (APPROVE_ENERGY * PRICE).toString() });
  });

  it('never broadcasts an approve its record no longer expects', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    chain.mine.delegate = false;
    const res = await submitApprove(p, signApprove(td));
    expect(res.status).toBe('pending');
    await prisma.tronApproval.update({
      where: { id: res.submissionId },
      data: { status: 'failed' },
    });
    const a = await prisma.tronApproval.findUniqueOrThrow({ where: { id: res.submissionId } });
    const d = { api: chain, kv: getKeyVault(), now: new Date(clock) };
    expect(await sendApprove(d, a)).toBe('refused');
    expect(chain.calls_to(USDT)).toHaveLength(0);
  });

  it('the daily loss cap refuses an approve in both fee modes', async () => {
    process.env.TENDR_SPONSOR_LOSS_CAP_USD = '0';
    loadEnv();
    try {
      for (const payer of [undefined, 'shopper'] as const) {
        const p = await tronQuote(payer);
        const err = await refusal(prepare(p));
        expect(err.code).toBe('GASLESS_NOT_AVAILABLE');
      }
      expect(chain.sent).toHaveLength(0);
    } finally {
      delete process.env.TENDR_SPONSOR_LOSS_CAP_USD;
      loadEnv();
    }
  });

  it('books lent energy the shopper spent elsewhere when its approve then fails', async () => {
    chain.approveFails = true;
    const p = await tronQuote();
    const td = await approveTd(p);
    await submitApprove(p, signApprove(td));
    const lent = (await prisma.tronDelegation.findFirstOrThrow()).units;
    // The shopper used the lent energy on its own transfer; its approve then ran out (receipt 20k).
    chain.own.set(WALLET, { energyUsed: lent });
    await pollAt(clock);
    await pollAt(clock);
    await pollAt(clock);
    const d = await prisma.tronDelegation.findFirstOrThrow();
    expect(d).toMatchObject({ status: 'reclaimed', energyUsedBefore: 0n, energyUsedAfter: lent });
    const a = await prisma.tronApproval.findFirstOrThrow();
    expect(a.closedAt).not.toBeNull();
    const tendr = await prisma.gasSponsorship.findFirstOrThrow({ where: { sponsor: 'tendr' } });
    expect(a.costBookedTo).toBe(`tendr:${tendr.id}`);
    expect(tendr.paymasterData).toMatchObject({ sun: (lent * PRICE).toString() });
    expect(tendr.costUsd?.toFixed()).toBe(usdOf(lent * PRICE));
  });

  it('a payment carries the lent energy actually consumed, not only its approve receipt', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    await submitApprove(p, signApprove(td));
    const lent = (await prisma.tronDelegation.findFirstOrThrow()).units;
    chain.own.set(WALLET, { energyUsed: lent });
    await pollAt(clock);
    const ptd = await paymentTd(p);
    const sub = await submitPayment(p, ptd, await signPayment(ptd));
    await pollAt(clock);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sub.submissionId } });
    expect(sp.status).toBe('confirmed');
    expect(sp.costUsd?.toFixed()).toBe(usdOf(110_000n * PRICE + 270_000n + lent * PRICE));
    await pollAt(clock);
    expect(await tendrUsd()).toBe('0');
  });

  it('refuses before lending energy when the USDT balance does not cover the payment', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    chain.balances.set(WALLET, BigInt(p.quote.amountIn.toFixed(0)) - 1n);
    const err = await refusal(submitApprove(p, signApprove(td)));
    expect(err.code).toBe('GASLESS_SUBMIT_FAILED');
    expect(err.details).toMatchObject({ reason: 'insufficient_token_balance' });
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.tronApproval.count()).toBe(0);
  });

  it('refuses before lending energy when the approve would revert', async () => {
    chain.approveReverts = true;
    const p = await tronQuote();
    const td = await approveTd(p);
    const err = await refusal(submitApprove(p, signApprove(td)));
    expect(err.code).toBe('GASLESS_SUBMIT_FAILED');
    expect(err.details).toMatchObject({ reason: 'approve_would_revert' });
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.tronApproval.count()).toBe(0);
  });

  it('counts the most a delegation can cost toward the loss cap the moment it is made', async () => {
    chain.mine.approve = false;
    const p = await tronQuote();
    const td = await approveTd(p);
    await submitApprove(p, signApprove(td));
    const d = await prisma.tronDelegation.findFirstOrThrow();
    const a = await prisma.tronApproval.findFirstOrThrow();
    const row = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: a.provisionalCostId! },
    });
    expect(row).toMatchObject({ sponsor: 'tendr', provider: 'gas-tron' });
    expect(row.lossRecognizedAt).not.toBeNull();
    expect(row.costUsd?.toFixed()).toBe(usdOf(d.units * PRICE));
    // With the cap at that amount, nothing more is lent.
    process.env.TENDR_SPONSOR_LOSS_CAP_USD = usdOf(d.units * PRICE);
    loadEnv();
    try {
      newWallet();
      const b = await tronQuote();
      expect((await refusal(prepare(b))).code).toBe('GASLESS_NOT_AVAILABLE');
    } finally {
      delete process.env.TENDR_SPONSOR_LOSS_CAP_USD;
      loadEnv();
    }
  });

  it('lends to one address at most three times per UTC day', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    for (let i = 0; i < 3; i++) {
      await prisma.tronApproval.create({
        data: {
          id: `tap_seed${i}`,
          merchantId: merchant.id,
          livemode: false,
          sessionId: p.s.id,
          quoteId: p.quote.id,
          wallet: WALLET,
          txId: `${i}`.padStart(64, '0'),
          signedTx: '00',
          expiration: new Date(clock),
          status: 'failed',
          plannedDelegations: 1,
        },
      });
    }
    const err = await refusal(submitApprove(p, signApprove(td)));
    expect(err.code).toBe('RATE_LIMITED');
    expect(chain.sent).toHaveLength(0);
  });

  it('fails an approval whose planned delegations never appeared, without sending it', async () => {
    const p = await tronQuote();
    const td = await approveTd(p);
    const s = signApprove(td);
    await prisma.tronApproval.create({
      data: {
        id: 'tap_orphan',
        merchantId: merchant.id,
        livemode: false,
        sessionId: p.s.id,
        quoteId: p.quote.id,
        wallet: WALLET,
        txId: td.transaction.txID,
        signedTx: s.rawDataHex,
        expiration: p.quote.deadline,
        status: 'pending',
        plannedDelegations: 1,
        createdAt: new Date(clock - 3 * 60_000),
      },
    });
    await pollAt(clock);
    expect(
      await prisma.tronApproval.findUniqueOrThrow({ where: { id: 'tap_orphan' } }),
    ).toMatchObject({ status: 'failed' });
    expect(chain.sent).toHaveLength(0);
  });

  it("another mode's approval of the wallet never blocks this one", async () => {
    const a = await tronQuote();
    // A live-mode approval of the same address that could still pay (issued, deadline ahead).
    await prisma.tronApproval.create({
      data: {
        id: 'tap_othermode',
        merchantId: merchant.id,
        livemode: true,
        sessionId: a.s.id,
        quoteId: 'quo_othermode',
        wallet: WALLET,
        txId: '1'.padStart(64, '0'),
        signedTx: '00',
        expiration: new Date(clock + 600_000),
        status: 'confirmed',
        paymentDeadline: new Date(clock + 600_000),
      },
    });
    expect((await prepare(a)).step).toBe('approve');
  });

  describe('test mode (simulated: no Tron API)', () => {
    it('options → quote → approve → TendrPayment → paid on detection → settled', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const s = await newSession();
      const opts = await call('POST', 'gasless/options', s.client_secret, {
        origin_asset: TOKEN.assetId,
        wallet_address: WALLET,
      });
      expect(opts.statusCode, opts.body).toBe(200);
      // Ruling T10-g: the chain's gas-fee account, in its own address form.
      expect(opts.json().fee_recipient).toBe(await tronGasFeeAddress());
      expect(opts.json().options).toEqual([
        { method: 'forwarder', paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null },
      ]);
      const qr = await call('POST', 'quote', s.client_secret, {
        origin_asset: TOKEN.assetId,
        wallet_address: WALLET,
        gasless_method: 'forwarder',
      });
      expect(qr.statusCode, qr.body).toBe(201);
      const quote = qr.json();
      const prep = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id });
      expect(prep.statusCode, prep.body).toBe(200);
      expect(prep.json().step).toBe('approve');
      const td = prep.json().to_sign[0].typed_data as ApproveTd;
      expect(td.transaction.raw_data.ref_block_bytes).toBe(TEST_TRON_REF_BLOCK.bytes);
      expect(td.transaction.raw_data.ref_block_hash).toBe(TEST_TRON_REF_BLOCK.hash);
      const bad = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        tron_approve: {
          raw_data_hex: td.transaction.raw_data_hex,
          signature: signApprove(td, { key: secp256k1.utils.randomPrivateKey() }).signature,
        },
      });
      expect(bad.statusCode, bad.body).toBe(409);
      const sub1 = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        tron_approve: (({ rawDataHex, signature }) => ({ raw_data_hex: rawDataHex, signature }))(
          signApprove(td),
        ),
      });
      expect(sub1.statusCode, sub1.body).toBe(202);
      expect(sub1.json()).toMatchObject({ status: 'confirmed', step: 'approve' });
      const st = await call(
        'GET',
        `gasless/submissions/${sub1.json().submission_id}`,
        s.client_secret,
      );
      expect(st.statusCode, st.body).toBe(200);
      expect(st.json()).toMatchObject({ status: 'confirmed', step: 'approve' });
      // The ledger behaves as live: one delegation, reclaimed.
      expect(await prisma.tronDelegation.findMany()).toEqual([
        expect.objectContaining({ receiver: WALLET, status: 'reclaimed', livemode: false }),
      ]);
      const prep2 = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id });
      expect(prep2.statusCode, prep2.body).toBe(200);
      expect(prep2.json().step).toBe('payment');
      const ptd = prep2.json().to_sign[0].typed_data as PaymentTd;
      // Test mode signs only test markers (ruling T10-f): the test domain at the sentinel.
      expect(ptd.domain).toEqual({
        name: TEST_PAYMENT_DOMAIN_NAME,
        version: '1',
        chainId: TRON_CHAIN_IDS.test,
        verifyingContract: TEST_VERIFYING_CONTRACT,
      });
      const sub2 = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signatures: {
          [TRON_PAYMENT_KIND]: { message: ptd.message, signature: await signPayment(ptd) },
        },
      });
      expect(sub2.statusCode, sub2.body).toBe(202);
      expect(sub2.json().status).toBe('confirmed');
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: sub2.json().submission_id },
      });
      expect(sp).toMatchObject({ method: 'forwarder', provider: 'gas-tron', status: 'confirmed' });
      await pollDeposit(quote.deposit_address, { livemode: false });
      const pay = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      expect(pay.status).toBe('SETTLED');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(chain.calls).toEqual([]);
    });
  });
});
