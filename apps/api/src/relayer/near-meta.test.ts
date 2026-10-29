// Gasless NEAR payments (NEP-366 meta-transactions relayed by `relayer-near`): the live path
// against a scripted NEAR JSON-RPC node (never a real one) on test-mode sessions (quotes from the
// 1Click simulator), and the test-mode flow end to end through the routes (no RPC at all).
import { ed25519 } from '@noble/curves/ed25519';
import { TEST_NEAR_RECEIVER } from '@tendr/contracts';
import type { Merchant } from '@prisma/client';
import bs58 from 'bs58';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { resetOneClickProviders, SimulatedOneClick } from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { pollDeposit, registerWatcherHooks } from '../checkout/watcher.js';
import { scopedDb } from '../db/scoped.js';
import { putGasPolicy } from '../gas/policy.js';
import { getKeyVault, nearPublicKey } from '../keyvault/index.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { fakeNearClient, RelayerNearSender, resetNearClients } from '../near/client.js';
import { eventLog } from '../near/events.js';
import { NearRpc, type RpcTransport } from '../near/rpc.js';
import {
  TGAS,
  decodeSigned,
  delegateAction,
  delegateActionHash,
  encodeSignedDelegateAction,
  functionCallAction,
  implicitAccountId,
  transferAction,
  type DecodedSignedTx,
} from '../near/tx.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';
import { gaslessQuote, resetRelayers } from './index.js';
import {
  NEAR_ASSUMED_BLOCK_MS,
  NEAR_DELEGATE_KIND,
  NEAR_EXPIRY_CONFIRM_MS,
  NEAR_GASLESS_TOKENS,
  NEAR_SIGNING_SLACK_BLOCKS,
  NEAR_RECORDED_PENDING_MS,
  NEAR_STALE_PENDING_MS,
  NearMetaGasless,
  pollNearMetaRelays,
  resetNearMetaRelayer,
  nearGasFeeAccount,
} from './near-meta.js';

const sim1click = isolatedSimStore();
const USDC = 'nep141:usdc.test'; // settlement asset (NEAR intents)
const TOKEN = NEAR_GASLESS_TOKENS.find((t) => t.symbol === 'USDT')!;
const CONTRACT = TOKEN.contract;
const WNEAR = 'nep141:wrap.near';
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const BURNT = 300_000_000_000_000_000_000n; // 0.0003 NEAR per outcome
const ONE_NEAR = 10n ** 24n;

type Delegate = {
  delegateAction: { senderId: string; receiverId: string; actions: unknown[] };
};

/** A scripted NEAR JSON-RPC node. */
class FakeNear implements RpcTransport {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  height = 150_000_000n;
  accounts = new Map<string, { amount: bigint; locked?: bigint; storage: number }>();
  /** `${account}/${ed25519:…}` → access key. */
  keys = new Map<string, { nonce: number; permission: unknown }>();
  relayer = '';
  relayerNonce = 7;
  registered = new Set<string>();
  balances = new Map<string, bigint>();
  /** Every transaction `send_tx` received (resends included); errors hit relays only. */
  sent: { hash: string; tx: DecodedSignedTx; base64: string }[] = [];
  outcomes = new Map<string, unknown>();
  /** `send_tx`: errors to throw, one per call, before answering normally. */
  sendErrors: unknown[] = [];
  /** A request that fails (an RPC outage for that method). */
  down: string | null = null;
  /** `storage_deposit` executes but fails (the contract refused it). */
  failStorage = false;
  /** `send_tx` of a `storage_deposit`: errors to throw, one per call (an unknown outcome). */
  storageSendErrors: unknown[] = [];

  storageDeposits() {
    return this.sent.filter((s) => s.tx.actions[0]?.kind === 'functionCall');
  }
  metaTxs() {
    return this.sent.filter((s) => s.tx.actions[0]?.kind === 'signedDelegate');
  }

  async request<T>(method: string, params: object): Promise<T> {
    const p = params as Record<string, unknown>;
    this.calls.push({ method, params: p });
    if (this.down === method || this.down === p.request_type || this.down === p.method_name) {
      throw new Error('socket hang up');
    }
    if (method === 'block') {
      return {
        header: { hash: bs58.encode(new Uint8Array(32).fill(3)), height: Number(this.height) },
      } as T;
    }
    if (method === 'query') {
      const account = p.account_id as string;
      if (p.request_type === 'view_access_key') {
        if (account === this.relayer)
          return { nonce: this.relayerNonce, permission: 'FullAccess' } as T;
        const k = this.keys.get(`${account}/${p.public_key as string}`);
        if (!k)
          return {
            error: `access key ${p.public_key as string} does not exist while viewing`,
          } as T;
        return { nonce: k.nonce, permission: k.permission, block_height: 1 } as T;
      }
      if (p.request_type === 'view_account') {
        const a = this.accounts.get(account);
        if (!a) return { error: `account ${account} does not exist while viewing` } as T;
        return {
          amount: a.amount.toString(),
          locked: (a.locked ?? 0n).toString(),
          storage_usage: a.storage,
        } as T;
      }
      if (p.request_type === 'call_function') {
        const args = JSON.parse(Buffer.from(p.args_base64 as string, 'base64').toString()) as {
          account_id?: string;
        };
        let v: unknown = null;
        if (p.method_name === 'storage_balance_of') {
          v = this.registered.has(`${account}/${args.account_id}`)
            ? { total: STORAGE_MIN.toString(), available: '0' }
            : null;
        } else if (p.method_name === 'storage_balance_bounds') {
          v = { min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() };
        } else if (p.method_name === 'ft_balance_of') {
          v = (this.balances.get(`${account}/${args.account_id}`) ?? 0n).toString();
        }
        return { result: Array.from(Buffer.from(JSON.stringify(v))), logs: [] } as T;
      }
    }
    if (method === 'send_tx') {
      const base64 = p.signed_tx_base64 as string;
      const tx = decodeSigned(Buffer.from(base64, 'base64'));
      const hash = bs58.encode(tx.hashBytes);
      this.sent.push({ hash, tx, base64 });
      // Injected errors hit the relay (a registration may be sent just before it).
      if (this.sendErrors.length && tx.actions[0]?.kind === 'signedDelegate') {
        throw this.sendErrors.shift();
      }
      const a = tx.actions[0]!;
      if (a.kind === 'functionCall') {
        const fc = a.fields as { methodName: string; args: Uint8Array };
        const args = JSON.parse(Buffer.from(fc.args).toString()) as { account_id: string };
        if (fc.methodName === 'storage_deposit') {
          if (this.storageSendErrors.length) throw this.storageSendErrors.shift();
          if (this.failStorage) {
            return {
              ...outcome(hash, tx.signerId, tx.receiverId, []),
              status: { Failure: {} },
            } as T;
          }
          this.registered.add(`${tx.receiverId}/${args.account_id}`);
        }
      }
      return outcome(hash, tx.signerId, tx.receiverId, []) as T;
    }
    if (method === 'EXPERIMENTAL_tx_status') {
      const o = this.outcomes.get(p.tx_hash as string);
      if (!o) throw Object.assign(new Error('x'), { type: 'UNKNOWN_TRANSACTION' });
      return o as T;
    }
    throw new Error(`unexpected ${method}`);
  }
}

/** A final outcome: the transaction plus receipts (`[executor, ok, logs]`). */
function outcome(
  hash: string,
  signer: string,
  receiver: string,
  receipts: [string, boolean, string[]][],
) {
  return {
    status: { SuccessValue: '' },
    transaction: { hash, signer_id: signer, receiver_id: receiver },
    transaction_outcome: {
      id: hash,
      outcome: {
        logs: [],
        status: { SuccessReceiptId: 'r0' },
        executor_id: signer,
        tokens_burnt: BURNT.toString(),
        gas_burnt: 3_000_000_000_000,
      },
    },
    receipts_outcome: receipts.map(([executor, ok, logs], i) => ({
      id: `r${i}`,
      outcome: {
        logs,
        status: ok
          ? { SuccessValue: '' }
          : {
              Failure: {
                ActionError: { kind: { FunctionCallError: { ExecutionError: 'panic' } } },
              },
            },
        executor_id: executor,
        tokens_burnt: BURNT.toString(),
        gas_burnt: 3_000_000_000_000,
      },
    })),
  };
}

/** The shopper's NEAR account (a fresh one per test: the per-wallet hourly limit). */
let WALLET = 'shopper.near';

const ftTransfer = (to: string, amount: bigint) => ({
  old_owner_id: WALLET,
  new_owner_id: to,
  amount: amount.toString(),
});

describe('NEAR gasless payments (NEP-366 meta-transactions)', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let secret: Uint8Array;
  let chain: FakeNear;
  let relayer: NearMetaGasless;
  let relayerAccount: string;
  let feeAccount: string;
  let clock: number;
  let sender: RelayerNearSender;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    resetNearMetaRelayer();
    resetNearClients();
    fakeNearClient(false);
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
    secret = ed25519.utils.randomPrivateKey();
    WALLET = `shopper-${Buffer.from(ed25519.utils.randomPrivateKey()).toString('hex').slice(0, 12)}.near`;
    chain = new FakeNear();
    relayerAccount = implicitAccountId((await getKeyVault().publicKey('relayer-near')).raw);
    feeAccount = implicitAccountId((await getKeyVault().publicKey('gas-fees-near')).raw);
    chain.relayer = relayerAccount;
    chain.accounts.set(WALLET, { amount: ONE_NEAR / 10n, storage: 500 });
    chain.keys.set(`${WALLET}/${nearPublicKey(ed25519.getPublicKey(secret))}`, {
      nonce: 42,
      permission: 'FullAccess',
    });
    chain.balances.set(`${CONTRACT}/${WALLET}`, 1_000_000_000n);
    clock = Date.now();
    sender = new RelayerNearSender(new NearRpc(chain), getKeyVault());
    relayer = new NearMetaGasless(true, { sender, now: () => new Date(clock) });
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    resetTokenCache();
    resetOneClickProviders();
    resetRelayers();
    resetNearClients();
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
        amount: '25.00',
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

  /** A `meta_tx` quote for the wallet; the merchant sponsors unless `shopper`. */
  async function metaQuote(gasPayer?: 'shopper', wallet = WALLET) {
    const s = await newSession(gasPayer);
    const qr = await call('POST', 'quote', s.client_secret, {
      origin_asset: TOKEN.assetId,
      wallet_address: wallet,
      gasless_method: 'meta_tx',
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: qr.json().id } });
    const scope = { merchantId: merchant.id, livemode: false };
    const ctx = { ...scope, db: scopedDb(scope), sessionId: s.id };
    const { q } = await gaslessQuote(ctx, quote.id);
    return { s, ctx, quote, q };
  }
  type MetaQuote = Awaited<ReturnType<typeof metaQuote>>;

  interface TypedData {
    sender_id: string;
    receiver_id: string;
    actions: {
      type: string;
      params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
    }[];
    max_block_height: string;
    block_height_ttl: number;
    relayer_id: string;
    transfers: { leg: string; token: string; to: string; amount: string }[];
  }

  type Over = {
    senderId?: string;
    receiverId?: string;
    actions?: TypedData['actions'];
    nonce?: bigint;
    maxBlockHeight?: bigint;
    secret?: Uint8Array;
    signWith?: Uint8Array;
    rawArgs?: string[];
    /** Signed actions as given (non-FunctionCall cases). */
    rawActions?: ReturnType<typeof transferAction>[];
  };

  /** What a wallet's `signDelegateActions` returns for the prepared payload (base64 borsh). */
  function signDelegate(td: TypedData, over: Over = {}): string {
    const acts = over.actions ?? td.actions;
    const actions = acts.map((a, i) =>
      over.rawArgs?.[i] !== undefined
        ? functionCallAction(
            a.params.methodName,
            {},
            BigInt(a.params.gas),
            BigInt(a.params.deposit),
          )
        : functionCallAction(
            a.params.methodName,
            a.params.args,
            BigInt(a.params.gas),
            BigInt(a.params.deposit),
          ),
    );
    over.rawArgs?.forEach((raw, i) => {
      if (raw !== undefined) actions[i]!.functionCall!.args = new TextEncoder().encode(raw);
    });
    const key = over.secret ?? secret;
    const d = delegateAction({
      senderId: over.senderId ?? td.sender_id,
      receiverId: over.receiverId ?? td.receiver_id,
      actions: over.rawActions ?? actions,
      nonce: over.nonce ?? 43n,
      maxBlockHeight: over.maxBlockHeight ?? BigInt(td.max_block_height),
      publicKey: ed25519.getPublicKey(key),
    });
    const sig = ed25519.sign(delegateActionHash(d), over.signWith ?? key);
    return Buffer.from(encodeSignedDelegateAction(d, sig)).toString('base64');
  }

  async function prepared(p: MetaQuote) {
    const payload = await relayer.prepare(p.q, {});
    return { payload, td: payload.to_sign[0]!.typed_data as TypedData };
  }

  const submit = (p: MetaQuote, signedDelegate: string) =>
    relayer.submit(p.q, { signatures: {}, signedDelegate });

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (err) {
      if (err instanceof AppError) return err;
      throw err;
    }
    throw new Error('expected a refusal');
  }

  const rowOf = (id: string) => prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });
  const pollAt = (at: number) =>
    pollNearMetaRelays({ sender, livemode: false, now: () => new Date(at) });

  const accountsRegistered = () =>
    chain.storageDeposits().map((d) => {
      const fc = d.tx.actions[0]!.fields as { args: Uint8Array };
      return (JSON.parse(Buffer.from(fc.args).toString()) as { account_id: string }).account_id;
    });

  it('prepares the delegate action without spending; registers then relays once at submit', async () => {
    const p = await metaQuote();
    expect(p.quote.networkFeePaidBy).toBe('merchant');
    const amount = p.quote.amountIn.toFixed(0);
    const { payload, td } = await prepared(p);
    // The bound is the block height at the quote deadline; the TTL leaves signing slack below it.
    const maxHeight =
      chain.height +
      BigInt(Math.floor((p.quote.deadline.getTime() - clock) / NEAR_ASSUMED_BLOCK_MS));
    expect(payload).toMatchObject({
      quote_id: p.quote.id,
      method: 'meta_tx',
      chain: 'near',
      chain_id: null,
      signer: WALLET,
      amount,
      fee_amount: '0',
    });
    expect(payload.to_sign).toHaveLength(1);
    expect(payload.to_sign[0]!.kind).toBe(NEAR_DELEGATE_KIND);
    expect(td).toEqual({
      sender_id: WALLET,
      receiver_id: CONTRACT,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'ft_transfer',
            args: { receiver_id: p.quote.depositAddress, amount },
            gas: (15n * TGAS).toString(),
            deposit: '1',
          },
        },
      ],
      max_block_height: maxHeight.toString(),
      block_height_ttl: Number(maxHeight - chain.height - NEAR_SIGNING_SLACK_BLOCKS),
      relayer_id: relayerAccount,
      expires_at: p.quote.deadline.toISOString(),
      transfers: [{ leg: 'payment', token: CONTRACT, to: p.quote.depositAddress, amount }],
    });

    // Prepare never spends: no registration, no Tendr cost row, however often it is called.
    await prepared(p);
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.gasSponsorship.count({ where: { sponsor: 'tendr' } })).toBe(0);

    const signed = signDelegate(td);
    const res = await submit(p, signed);
    // At submit, after every check: one storage_deposit from relayer-near, then the relay.
    expect(chain.sent.map((s) => s.tx.actions[0]!.kind)).toEqual([
      'functionCall',
      'signedDelegate',
    ]);
    const deposit = chain.storageDeposits()[0]!;
    expect(deposit.tx.signerId).toBe(relayerAccount);
    expect(deposit.tx.receiverId).toBe(CONTRACT);
    const fc = deposit.tx.actions[0]!.fields as { args: Uint8Array; deposit: bigint };
    expect(JSON.parse(Buffer.from(fc.args).toString())).toEqual({
      account_id: p.quote.depositAddress,
      registration_only: true,
    });
    expect(BigInt(fc.deposit)).toBe(STORAGE_MIN);
    const outer = chain.metaTxs()[0]!;
    expect(res).toEqual({
      submissionId: p.quote.gasSponsorshipId,
      txHash: outer.hash,
      status: 'submitted',
    });
    // relayer-near → the shopper's account, one Delegate action: the signed delegate as given.
    expect(outer.tx.signerId).toBe(relayerAccount);
    expect(outer.tx.receiverId).toBe(WALLET);
    expect(outer.tx.actions).toHaveLength(1);
    const sd = outer.tx.actions[0]!.fields as unknown as Delegate;
    expect(sd.delegateAction.senderId).toBe(WALLET);
    expect(sd.delegateAction.receiverId).toBe(CONTRACT);

    const sp = await rowOf(p.quote.gasSponsorshipId!);
    expect(sp).toMatchObject({
      quoteId: p.quote.id,
      method: 'meta_tx',
      provider: 'relayer-near',
      sponsor: 'merchant',
      status: 'submitted',
      reservationState: 'reserved',
      signerAddress: WALLET,
      txHash: outer.hash,
    });
    // The registration's cost (deposit + gas) belongs to this payment's cost.
    expect(sp.paymasterData).toEqual({
      kind: 'near_meta',
      hash: outer.hash,
      relayer: relayerAccount,
      transaction: outer.base64,
      delegate: signed,
      maxBlockHeight: td.max_block_height,
      storageYocto: (STORAGE_MIN + BURNT).toString(),
    });
    expect(await prisma.gasSponsorship.count({ where: { sponsor: 'tendr' } })).toBe(0);
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } });
    expect(quote.depositTxHash).toBe(outer.hash);

    // A repeat returns the same submission without sending again; no new delegate action can be
    // prepared while this one may still execute.
    expect(await submit(p, signed)).toMatchObject({ submissionId: sp.id, status: 'submitted' });
    expect(chain.sent).toHaveLength(2);
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({
      code: 'CONFLICT',
      details: { submission_id: sp.id },
    });
  });

  it('repeated prepares across sessions spend nothing (no registration without a payer)', async () => {
    for (let i = 0; i < 3; i++) {
      const p = await metaQuote(i % 2 ? 'shopper' : undefined);
      await prepared(p);
      await prepared(p);
    }
    expect(chain.sent).toHaveLength(0);
    expect(await prisma.gasSponsorship.count({ where: { sponsor: 'tendr' } })).toBe(0);
  });

  it('a wallet signing 60 s later against an optimistic head is accepted', async () => {
    const p = await metaQuote();
    const prepareClock = clock;
    const prepareHead = chain.height;
    const { td } = await prepared(p);
    // 60 s at ~1.6 blocks/s, and the wallet's optimistic head runs 4 blocks ahead of final.
    chain.height = prepareHead + 96n;
    clock += 60_000;
    const walletHead = chain.height + 4n;
    const res = await submit(
      p,
      signDelegate(td, { maxBlockHeight: walletHead + BigInt(td.block_height_ttl) }),
    );
    expect(res.status).toBe('submitted');
    // The issued bound never exceeds the block height at the quote deadline.
    expect(BigInt(td.max_block_height)).toBe(
      prepareHead + BigInt(Math.floor((p.quote.deadline.getTime() - prepareClock) / 1000)),
    );
  });

  it('a quote too close to its deadline for signing slack is refused at prepare', async () => {
    const p = await metaQuote();
    // ~100 s left: the deadline's height leaves less than the slack plus a minimum TTL.
    clock = p.quote.deadline.getTime() - 100_000;
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({ code: 'QUOTE_EXPIRED' });
    expect(chain.sent).toHaveLength(0);
  });

  it('a merchant hold that can no longer be claimed is refused at prepare (re-quote first)', async () => {
    const p = await metaQuote();
    await prisma.gasSponsorship.update({
      where: { id: p.quote.gasSponsorshipId! },
      data: { reservationState: 'released' },
    });
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({
      code: 'SPONSORSHIP_RELEASED',
    });
  });

  it('a registration in progress elsewhere (lock held): 503, nothing relayed, retry works', async () => {
    const p = await metaQuote();
    const { td } = await prepared(p);
    const signed = signDelegate(td);
    const lock = `tendr:gasless:near-storage:${CONTRACT}:${p.quote.depositAddress}`;
    await getRedis().set(lock, '1', 'EX', 60);
    expect(await refusal(submit(p, signed))).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
    });
    expect(chain.sent).toHaveLength(0);
    expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({ quoteId: null });
    // The other registration finished: the same signed delegate relays, with no deposit.
    chain.registered.add(`${CONTRACT}/${p.quote.depositAddress}`);
    expect((await submit(p, signed)).status).toBe('submitted');
    expect(chain.storageDeposits()).toHaveLength(0);
    expect(
      ((await rowOf(p.quote.gasSponsorshipId!)).paymasterData as { storageYocto?: string })
        .storageYocto,
    ).toBeUndefined();
    await getRedis().del(lock);
  });

  it('a registration that fails on chain: not relayed, its gas is a Tendr cost', async () => {
    const p = await metaQuote();
    const { td } = await prepared(p);
    chain.failStorage = true;
    expect(await refusal(submit(p, signDelegate(td)))).toMatchObject({ status: 503 });
    expect(chain.metaTxs()).toHaveLength(0);
    expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({ quoteId: null });
    const loss = await prisma.gasSponsorship.findFirstOrThrow({ where: { sponsor: 'tendr' } });
    expect(loss.lossRecognizedAt).not.toBeNull();
    // Gas only (the deposit is refunded): 0.0003 NEAR × $3.
    expect(loss.costUsd!.toFixed()).toBe('0.0009');
  });

  it('a registration with an unknown outcome: not relayed, its most cost is a Tendr loss at once', async () => {
    const p = await metaQuote();
    const { td } = await prepared(p);
    // The send and its identical resend both time out: it may still execute.
    const timeout = () => Object.assign(new Error('Timeout'), { type: 'TimeoutError' });
    chain.storageSendErrors = [timeout(), timeout()];
    expect(await refusal(submit(p, signDelegate(td)))).toMatchObject({ status: 503 });
    expect(chain.metaTxs()).toHaveLength(0);
    expect(chain.storageDeposits()).toHaveLength(2); // the same bytes, sent twice
    const loss = await prisma.gasSponsorship.findFirstOrThrow({ where: { sponsor: 'tendr' } });
    expect(loss.lossRecognizedAt).not.toBeNull();
    expect(loss.txHash).toBe(chain.storageDeposits()[0]!.hash);
    // The deposit (0.00125 NEAR) + 30 Tgas at 1e8 yocto/gas (0.003 NEAR), × $3.
    expect(loss.costUsd!.toFixed()).toBe('0.01275');
    await getRedis().del(`tendr:gasless:near-storage:${CONTRACT}:${p.quote.depositAddress}`);
  });

  it('the shopper pays: a second ft_transfer of the fee to the gas-fees-near account', async () => {
    const p = await metaQuote('shopper');
    expect(p.quote.networkFeePaidBy).toBe('buyer');
    const fee = p.quote.networkFeeAmount!.toFixed(0);
    const { payload, td } = await prepared(p);
    expect(payload.fee_amount).toBe(fee);
    expect(td.actions.map((a) => a.params.args)).toEqual([
      { receiver_id: p.quote.depositAddress, amount: p.quote.amountIn.toFixed(0) },
      { receiver_id: feeAccount, amount: fee },
    ]);
    expect(td.actions.every((a) => a.params.deposit === '1')).toBe(true);
    expect(td.transfers[1]).toEqual({ leg: 'fee', token: CONTRACT, to: feeAccount, amount: fee });

    // A sponsored-shaped delegate (no fee leg) is refused, before any registration.
    expect(await refusal(submit(p, signDelegate(td, { actions: [td.actions[0]!] })))).toMatchObject(
      { code: 'GASLESS_PAYLOAD_MISMATCH', details: { field: 'signed_delegate.actions' } },
    );
    expect(chain.sent).toHaveLength(0);
    const res = await submit(p, signDelegate(td));
    expect(res.status).toBe('submitted');
    // Both receiving accounts registered, each once, before the relay.
    expect(accountsRegistered()).toEqual([p.quote.depositAddress, feeAccount]);
    expect(await rowOf(res.submissionId)).toMatchObject({
      sponsor: 'shopper',
      method: 'meta_tx',
      feeAmount: p.quote.networkFeeAmount,
    });
  });

  describe('refuses anything but the quoted payment, before relaying', () => {
    const other = ed25519.utils.randomPrivateKey();
    const cases: [string, (td: TypedData) => Over, string][] = [
      [
        'another token contract',
        () => ({ receiverId: 'evil.near' }),
        'signed_delegate.receiver_id',
      ],
      // Live never accepts the test-mode receiver (ruling T10-f).
      [
        'the test-mode receiver',
        () => ({ receiverId: TEST_NEAR_RECEIVER }),
        'signed_delegate.receiver_id',
      ],
      ['another sender', () => ({ senderId: 'other.near' }), 'signed_delegate.sender_id'],
      [
        'an extra action',
        (td) => ({ actions: [td.actions[0]!, td.actions[0]!] }),
        'signed_delegate.actions',
      ],
      [
        'a changed amount',
        (td) => ({
          actions: [
            {
              ...td.actions[0]!,
              params: {
                ...td.actions[0]!.params,
                args: { ...td.actions[0]!.params.args, amount: '1' },
              },
            },
          ],
        }),
        'signed_delegate.actions[0].args',
      ],
      [
        'another receiver',
        (td) => ({
          actions: [
            {
              ...td.actions[0]!,
              params: {
                ...td.actions[0]!.params,
                args: { ...td.actions[0]!.params.args, receiver_id: 'evil.near' },
              },
            },
          ],
        }),
        'signed_delegate.actions[0].args',
      ],
      [
        'a memo',
        (td) => ({
          actions: [
            {
              ...td.actions[0]!,
              params: {
                ...td.actions[0]!.params,
                args: { ...td.actions[0]!.params.args, memo: 'x' },
              },
            },
          ],
        }),
        'signed_delegate.actions[0].args',
      ],
      [
        'duplicate argument keys',
        (td) => ({
          rawArgs: [
            `{"receiver_id":"${td.actions[0]!.params.args.receiver_id as string}","amount":"${td.actions[0]!.params.args.amount as string}","amount":"1"}`,
          ],
        }),
        'signed_delegate.actions[0].args',
      ],
      [
        'another method',
        (td) => ({
          actions: [
            {
              ...td.actions[0]!,
              params: { ...td.actions[0]!.params, methodName: 'ft_transfer_call' },
            },
          ],
        }),
        'signed_delegate.actions[0].method',
      ],
      [
        'more than 1 yoctoNEAR attached',
        (td) => ({
          actions: [{ ...td.actions[0]!, params: { ...td.actions[0]!.params, deposit: '2' } }],
        }),
        'signed_delegate.actions[0].deposit',
      ],
      [
        'gas above the bound',
        (td) => ({
          actions: [
            {
              ...td.actions[0]!,
              params: { ...td.actions[0]!.params, gas: (31n * TGAS).toString() },
            },
          ],
        }),
        'signed_delegate.actions[0].gas',
      ],
      ['a signature by another key', () => ({ signWith: other }), 'signed_delegate.signature'],
      ['a key the account does not have', () => ({ secret: other }), 'signed_delegate.public_key'],
      ['a used nonce', () => ({ nonce: 42n }), 'signed_delegate.nonce'],
      [
        'a nonce nearcore refuses (≥ block height × 10^6)',
        () => ({ nonce: 150_000_000n * 1_000_000n }),
        'signed_delegate.nonce',
      ],
      [
        'a Transfer instead of the ft_transfer',
        () => ({ rawActions: [transferAction(1n)] }),
        'signed_delegate.actions[0]',
      ],
      [
        'a numeric amount',
        (td) => ({
          rawArgs: [
            `{"receiver_id":"${td.actions[0]!.params.args.receiver_id as string}","amount":${td.actions[0]!.params.args.amount as string}}`,
          ],
        }),
        'signed_delegate.actions[0].args',
      ],
      [
        'reordered argument keys',
        (td) => ({
          rawArgs: [
            `{"amount":"${td.actions[0]!.params.args.amount as string}","receiver_id":"${td.actions[0]!.params.args.receiver_id as string}"}`,
          ],
        }),
        'signed_delegate.actions[0].args',
      ],
      [
        'a max_block_height past the quote deadline',
        (td) => ({ maxBlockHeight: BigInt(td.max_block_height) + 1n }),
        'signed_delegate.max_block_height',
      ],
    ];
    for (const [name, over, field] of cases) {
      it(name, async () => {
        const p = await metaQuote();
        const { td } = await prepared(p);
        expect(await refusal(submit(p, signDelegate(td, over(td))))).toMatchObject({
          code: 'GASLESS_PAYLOAD_MISMATCH',
          status: 409,
          details: { field },
        });
        expect(chain.metaTxs()).toHaveLength(0);
        const sp = await rowOf(p.quote.gasSponsorshipId!);
        expect(sp.quoteId).toBeNull();
        // Refused payloads do not count against the wallet's limit.
        const key = `tendr:gasless:submit:addr:${WALLET}:${Math.floor(Date.now() / 3_600_000)}`;
        expect(await getRedis().get(key)).toBeNull();
      });
    }

    it('a function-call access key (not full access)', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      chain.keys.set(`${WALLET}/${nearPublicKey(ed25519.getPublicKey(secret))}`, {
        nonce: 42,
        permission: { FunctionCall: { allowance: null, receiver_id: CONTRACT, method_names: [] } },
      });
      expect(await refusal(submit(p, signDelegate(td)))).toMatchObject({
        code: 'GASLESS_PAYLOAD_MISMATCH',
        details: { field: 'signed_delegate.public_key' },
      });
      expect(chain.metaTxs()).toHaveLength(0);
    });

    it('bytes that are not one canonical signed delegate', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      const bytes = Buffer.from(signDelegate(td), 'base64');
      const padded = Buffer.concat([bytes, Buffer.from([0])]).toString('base64');
      expect(await refusal(submit(p, padded))).toMatchObject({
        code: 'GASLESS_PAYLOAD_MISMATCH',
        details: { field: 'signed_delegate' },
      });
      expect(
        await refusal(
          relayer.submit(p.q, { signatures: {}, transaction: bytes.toString('base64') }),
        ),
      ).toMatchObject({ code: 'GASLESS_PAYLOAD_MISMATCH', details: { field: 'signed_delegate' } });
    });
  });

  it('a delegate action already past its max_block_height is GASLESS_EXPIRED', async () => {
    const p = await metaQuote();
    const { td } = await prepared(p);
    expect(
      await refusal(submit(p, signDelegate(td, { maxBlockHeight: chain.height }))),
    ).toMatchObject({ code: 'GASLESS_EXPIRED' });
    expect(chain.metaTxs()).toHaveLength(0);
  });

  it('an account without a trace of NEAR: the option is unavailable', async () => {
    // 1000 bytes of storage lock 0.01 NEAR: an account holding exactly that has nothing spare.
    // (Up to 770 bytes are free: NEP-448 zero-balance accounts.)
    chain.accounts.set(WALLET, { amount: 10_000_000_000_000_000_000_000n, storage: 1000 });
    const s = await newSession();
    const opts = await relayer.options({
      shopper: {
        merchantId: merchant.id,
        livemode: false,
        db: scopedDb({ merchantId: merchant.id, livemode: false }),
        sessionId: s.id,
      },
      session: await prisma.session.findUniqueOrThrow({ where: { id: s.id } }),
      origin: {
        assetId: TOKEN.assetId,
        blockchain: 'near',
        symbol: 'USDT',
        decimals: 6,
      } as Parameters<NearMetaGasless['options']>[0]['origin'],
      walletAddress: WALLET,
    });
    expect(opts).toEqual([
      {
        method: 'meta_tx',
        paid_by: 'shopper',
        reason: null,
        fee_modes: [],
        token_fee: null,
        unavailable_reason: 'near_account_needs_balance',
      },
    ]);
    const p = await metaQuote();
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({
      code: 'GASLESS_NOT_AVAILABLE',
      details: { reason: 'near_account_needs_balance' },
    });
    // Nothing registered for a shopper who cannot pay.
    expect(chain.storageDeposits()).toHaveLength(0);

    // An account that does not exist at all, likewise.
    chain.accounts.delete(WALLET);
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({
      details: { reason: 'near_account_needs_balance' },
    });
    // 1 yoctoNEAR spare is enough.
    chain.accounts.set(WALLET, { amount: 10_000_000_000_000_000_000_001n, storage: 1000 });
    await expect(relayer.prepare(p.q, {})).resolves.toBeTruthy();
  });

  it('a token balance below the payment is refused before any gas is spent', async () => {
    const p = await metaQuote();
    const { td } = await prepared(p);
    chain.balances.set(`${CONTRACT}/${WALLET}`, BigInt(p.quote.amountIn.toFixed(0)) - 1n);
    expect(await refusal(submit(p, signDelegate(td)))).toMatchObject({
      code: 'GASLESS_SUBMIT_FAILED',
      details: { reason: 'insufficient_token_balance' },
    });
    expect(chain.metaTxs()).toHaveLength(0);
  });

  it('only allow-listed NEP-141 USDC/USDT: wNEAR gets no option and no meta_tx quote', async () => {
    const s = await newSession();
    const opts = await call('POST', 'gasless/options', s.client_secret, {
      origin_asset: WNEAR,
      wallet_address: WALLET,
    });
    expect(opts.statusCode, opts.body).toBe(200);
    expect(opts.json()).toMatchObject({ chain: 'near', family: 'near', options: [] });
    const quote = await call('POST', 'quote', s.client_secret, {
      origin_asset: WNEAR,
      wallet_address: WALLET,
      gasless_method: 'meta_tx',
    });
    expect(quote.statusCode, quote.body).toBe(400);
    expect(quote.json().error.details).toMatchObject({ field: 'gasless_method' });
  });

  it('the daily loss cap stops prepare and submit in both modes', async () => {
    const sponsored = await metaQuote();
    const paying = await metaQuote('shopper');
    const a = signDelegate((await prepared(sponsored)).td);
    const b = signDelegate((await prepared(paying)).td);
    await prisma.gasSponsorship.create({
      data: {
        id: newId('gas'),
        merchantId: merchant.id,
        livemode: false,
        sessionId: sponsored.s.id,
        chain: 'near',
        method: 'meta_tx',
        provider: 'relayer-near',
        sponsor: 'tendr',
        status: 'failed',
        costUsd: '1000',
        lossRecognizedAt: new Date(),
      },
    });
    for (const [x, signed] of [
      [sponsored, a],
      [paying, b],
    ] as const) {
      expect(await refusal(relayer.prepare(x.q, {}))).toMatchObject({
        code: 'GASLESS_NOT_AVAILABLE',
      });
      expect(await refusal(submit(x, signed))).toMatchObject({ code: 'GASLESS_NOT_AVAILABLE' });
    }
    expect(chain.metaTxs()).toHaveLength(0);
  });

  describe('nothing sent: the claim is undone and the shopper may retry', () => {
    it('the node rejects the transaction as invalid: GASLESS_SUBMIT_FAILED', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      const signed = signDelegate(td);
      chain.sendErrors = [Object.assign(new Error('invalid'), { type: 'InvalidTxError' })];
      expect(await refusal(submit(p, signed))).toMatchObject({
        code: 'GASLESS_SUBMIT_FAILED',
        status: 409,
      });
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({
        quoteId: null,
        status: 'pending',
        reservationState: 'reserved',
        txHash: null,
        paymasterData: null,
      });
      // The registration made for this attempt was paid for nothing it relayed: Tendr's cost,
      // (0.00125 + 0.0003) NEAR × $3.
      const loss = await prisma.gasSponsorship.findFirstOrThrow({ where: { sponsor: 'tendr' } });
      expect(loss.costUsd!.toFixed()).toBe('0.00465');
      expect(loss.lossRecognizedAt).not.toBeNull();
      // The retry needs no second registration and carries none in its cost.
      const again = await submit(p, signed);
      expect(again.status).toBe('submitted');
      expect(chain.storageDeposits()).toHaveLength(1);
      expect(
        ((await rowOf(again.submissionId)).paymasterData as { storageYocto?: string }).storageYocto,
      ).toBeUndefined();
    });

    it('a stale relayer nonce: re-signed once, the new hash recorded before sending', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      chain.sendErrors = [Object.assign(new Error('nonce'), { type: 'InvalidNonce' })];
      const res = await submit(p, signDelegate(td));
      const metas = chain.metaTxs();
      expect(metas).toHaveLength(2);
      expect(metas[0]!.hash).not.toBe(metas[1]!.hash);
      expect(res.txHash).toBe(metas[1]!.hash);
      const sp = await rowOf(res.submissionId);
      expect(sp.txHash).toBe(metas[1]!.hash);
      expect((sp.paymasterData as { hash: string }).hash).toBe(metas[1]!.hash);
    });

    it('the transaction cannot be recorded: never broadcast', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      const failing = new NearMetaGasless(true, {
        sender,
        now: () => new Date(clock),
        record: async () => {
          throw new Error('db down');
        },
      });
      expect(
        await refusal(failing.submit(p.q, { signatures: {}, signedDelegate: signDelegate(td) })),
      ).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
      expect(chain.metaTxs()).toHaveLength(0);
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({ quoteId: null });
    });
  });

  it('broadcast outcome unknown: submitted with its known hash, re-sent, no new delegate until it cannot execute', async () => {
    const p = await metaQuote('shopper');
    const { td } = await prepared(p);
    chain.sendErrors = [new Error('timeout'), new Error('timeout again')];
    const res = await submit(p, signDelegate(td));
    const first = chain.metaTxs()[0]!;
    expect(res).toMatchObject({ txHash: first.hash, status: 'submitted' });
    expect(await rowOf(res.submissionId)).toMatchObject({
      status: 'submitted',
      txHash: first.hash,
    });

    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({ code: 'CONFLICT' });

    // Not seen, still executable (final height ≤ max_block_height): the same bytes again.
    expect(await pollAt(clock)).toBe(0);
    const metas = chain.metaTxs();
    expect(metas.at(-1)!.base64).toBe(first.base64);
    expect((await rowOf(res.submissionId)).status).toBe('submitted');

    // Past max_block_height at the final head and never seen: failed only on a second look a
    // poll interval later; until then the quote stays locked.
    chain.height = BigInt(td.max_block_height) + 1n;
    const sent = chain.metaTxs().length;
    const t0 = clock + 60_000;
    expect(await pollAt(t0)).toBe(0);
    expect(chain.metaTxs()).toHaveLength(sent);
    expect((await rowOf(res.submissionId)).status).toBe('submitted');
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({ code: 'CONFLICT' });
    expect(await pollAt(t0 + NEAR_EXPIRY_CONFIRM_MS - 1000)).toBe(0);
    expect((await rowOf(res.submissionId)).status).toBe('submitted');
    expect(await pollAt(t0 + NEAR_EXPIRY_CONFIRM_MS)).toBe(1);
    const failed = await rowOf(res.submissionId);
    expect(failed).toMatchObject({ status: 'failed', sponsor: 'shopper' });
    expect(failed.lossRecognizedAt).toBeNull();

    // Now a new delegate action can be prepared and relayed (a new outer hash).
    chain.height = 150_000_000n;
    const again = await prepared(p);
    const second = await submit(p, signDelegate(again.td, { nonce: 44n }));
    expect(second.submissionId).not.toBe(res.submissionId);
    expect(second.txHash).not.toBe(first.hash);
  });

  it('a still-executable delegate seen again before expiry clears the first look', async () => {
    const p = await metaQuote();
    const { td } = await prepared(p);
    chain.sendErrors = [new Error('t'), new Error('t')];
    const res = await submit(p, signDelegate(td));
    chain.height = BigInt(td.max_block_height) + 1n;
    await pollAt(clock);
    expect((await rowOf(res.submissionId)).paymasterData).toHaveProperty('expiredSeenAt');
    // A lagging node reports a lower final head: still executable, the first look is dropped.
    chain.height = BigInt(td.max_block_height);
    await pollAt(clock + 5_000);
    expect((await rowOf(res.submissionId)).paymasterData).not.toHaveProperty('expiredSeenAt');
  });

  describe('poller hygiene', () => {
    it('a claimed row with no recorded transaction is undone once stale', async () => {
      const p = await metaQuote();
      await prisma.gasSponsorship.update({
        where: { id: p.quote.gasSponsorshipId! },
        data: { quoteId: p.quote.id, signerAddress: WALLET },
      });
      expect(await pollAt(Date.now())).toBe(0);
      expect((await rowOf(p.quote.gasSponsorshipId!)).quoteId).toBe(p.quote.id);
      expect(await pollAt(Date.now() + NEAR_STALE_PENDING_MS + 1000)).toBe(1);
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({
        quoteId: null,
        status: 'pending',
        reservationState: 'reserved',
      });
    });

    it('a row recorded but never marked submitted (crash) is picked up by its hash', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      const res = await submit(p, signDelegate(td));
      await prisma.gasSponsorship.update({
        where: { id: res.submissionId },
        data: { status: 'pending' },
      });
      await prisma.quote.update({ where: { id: p.quote.id }, data: { depositTxHash: null } });
      await pollAt(Date.now() + NEAR_RECORDED_PENDING_MS - 5_000);
      expect((await rowOf(res.submissionId)).status).toBe('pending');
      await pollAt(Date.now() + NEAR_RECORDED_PENDING_MS + 1_000);
      expect(await rowOf(res.submissionId)).toMatchObject({
        status: 'submitted',
        txHash: res.txHash,
      });
      expect(
        (await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } })).depositTxHash,
      ).toBe(res.txHash);
    });

    it('a row whose lookup fails is marked checked, so it cannot starve the others', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      const res = await submit(p, signDelegate(td));
      chain.down = 'EXPERIMENTAL_tx_status';
      const at = Date.now() + 5_000;
      expect(await pollAt(at)).toBe(0);
      expect((await rowOf(res.submissionId)).updatedAt.getTime()).toBe(at);
    });
  });

  describe('outcomes (EXPERIMENTAL_tx_status on the stored hash)', () => {
    it('sponsored: confirmed with the NEAR it burnt; settled only at collection', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      const res = await submit(p, signDelegate(td));
      const amount = BigInt(p.quote.amountIn.toFixed(0));
      chain.outcomes.set(
        res.txHash!,
        outcome(res.txHash!, relayerAccount, WALLET, [
          [WALLET, true, []],
          [
            CONTRACT,
            true,
            [
              eventLog('nep141', '1.0.0', 'ft_transfer', [
                ftTransfer(p.quote.depositAddress, amount),
              ]),
            ],
          ],
        ]),
      );
      expect(await pollAt(Date.now())).toBe(1);
      const sp = await rowOf(res.submissionId);
      // (3 outcomes × 0.0003 NEAR + the registration's 0.00125 + 0.0003 NEAR) × $3 = $0.00735.
      expect(sp).toMatchObject({
        status: 'confirmed',
        txHash: res.txHash,
        reservationState: 'reserved',
      });
      expect(sp.costUsd!.toFixed()).toBe('0.00735');
      expect(sp.gasUsed!.toFixed()).toBe('9000000000000');
      expect(await pollAt(Date.now())).toBe(0);
    });

    it('shopper pays: revenue from the fee ft_transfer event, capped at the fee signed', async () => {
      const p = await metaQuote('shopper');
      const { td } = await prepared(p);
      const res = await submit(p, signDelegate(td));
      const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
      chain.outcomes.set(
        res.txHash!,
        outcome(res.txHash!, relayerAccount, WALLET, [
          [WALLET, true, []],
          [
            CONTRACT,
            true,
            [
              eventLog('nep141', '1.0.0', 'ft_transfer', [
                ftTransfer(p.quote.depositAddress, BigInt(p.quote.amountIn.toFixed(0))),
                ftTransfer(feeAccount, fee + 5n),
              ]),
            ],
          ],
          // Another contract's claim of a transfer to the fee account never counts.
          [
            'evil.near',
            true,
            [eventLog('nep141', '1.0.0', 'ft_transfer', [ftTransfer(feeAccount, 9n)])],
          ],
        ]),
      );
      expect(await pollAt(Date.now())).toBe(1);
      const sp = await rowOf(res.submissionId);
      expect(sp.status).toBe('confirmed');
      expect(sp.feeCollected!.toFixed()).toBe(fee.toString());
    });

    it('a failed ft_transfer receipt: failed with its cost; a shopper relay is a loss', async () => {
      const p = await metaQuote('shopper');
      const { td } = await prepared(p);
      const res = await submit(p, signDelegate(td));
      chain.outcomes.set(
        res.txHash!,
        outcome(res.txHash!, relayerAccount, WALLET, [
          [WALLET, true, []],
          [CONTRACT, false, []],
        ]),
      );
      expect(await pollAt(Date.now())).toBe(1);
      const sp = await rowOf(res.submissionId);
      expect(sp).toMatchObject({ status: 'failed', sponsor: 'tendr' });
      expect(sp.lossRecognizedAt).not.toBeNull();
      expect(sp.feeCollected).toBeNull();
    });

    it('the delegate itself failed (e.g. expired): failed, the merchant hold is kept', async () => {
      const p = await metaQuote();
      const { td } = await prepared(p);
      const res = await submit(p, signDelegate(td));
      chain.outcomes.set(
        res.txHash!,
        outcome(res.txHash!, relayerAccount, WALLET, [[WALLET, false, []]]),
      );
      expect(await pollAt(Date.now())).toBe(1);
      expect(await rowOf(res.submissionId)).toMatchObject({
        status: 'failed',
        sponsor: 'merchant',
        reservationState: 'reserved',
      });
    });
  });

  describe('test mode (simulated: no NEAR RPC)', () => {
    it('options → quote → prepare → sign → submit → paid on detection → settled', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const s = await newSession();
      const opts = await call('POST', 'gasless/options', s.client_secret, {
        origin_asset: TOKEN.assetId,
        wallet_address: WALLET,
      });
      expect(opts.statusCode, opts.body).toBe(200);
      // Ruling T10-g: the chain's gas-fee account, in its own address form.
      expect(opts.json().fee_recipient).toBe(await nearGasFeeAccount());
      expect(opts.json().options).toEqual([
        { method: 'meta_tx', paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null },
      ]);
      const qr = await call('POST', 'quote', s.client_secret, {
        origin_asset: TOKEN.assetId,
        wallet_address: WALLET,
        gasless_method: 'meta_tx',
      });
      expect(qr.statusCode, qr.body).toBe(201);
      const quote = qr.json();
      const prep = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id });
      expect(prep.statusCode, prep.body).toBe(200);
      const td = prep.json().to_sign[0].typed_data as TypedData;
      // Test mode signs a delegate to an account that cannot exist (ruling T10-f).
      expect(td.receiver_id).toBe(TEST_NEAR_RECEIVER);
      // A tampered delegate is refused in test mode too, and so is one to the real contract.
      for (const receiverId of ['evil.near', CONTRACT]) {
        const bad = await call('POST', 'gasless/submit', s.client_secret, {
          quote_id: quote.id,
          signed_delegate: signDelegate(td, { receiverId }),
        });
        expect(bad.statusCode, bad.body).toBe(409);
        expect(bad.json().error.code).toBe('GASLESS_PAYLOAD_MISMATCH');
      }
      const sub = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        signed_delegate: signDelegate(td),
      });
      expect(sub.statusCode, sub.body).toBe(202);
      expect(sub.json().status).toBe('confirmed');
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: sub.json().submission_id },
      });
      expect(sp).toMatchObject({
        method: 'meta_tx',
        provider: 'relayer-near',
        status: 'confirmed',
        reservationState: 'reserved',
      });
      expect(await prisma.payment.count()).toBe(0);
      await pollDeposit(quote.deposit_address, { livemode: false });
      const pay = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      expect(pay.status).toBe('SETTLED');
      expect(await rowOf(sp.id)).toMatchObject({
        reservationState: 'settled',
        recoveredFromPaymentId: pay.id,
      });
      // No NEAR RPC, nothing over HTTP.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(chain.calls).toEqual([]);
    });
  });
});
