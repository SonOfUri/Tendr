import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { id } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIDEPOOL_TOKENS as T, TIDEPOOL_VERIFIER as V } from '@tendr/contracts';
import { buildApp } from '../app.js';
import { loadEnv } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { eventLog } from '../near/events.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import {
  createApiKey,
  createCredential,
  createMerchant,
  createRow,
  createUser,
  resetDb,
} from '../test/helpers.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import {
  HttpOneClick,
  resetOneClickProviders,
  simulatedOneClick,
  type StatusResponse,
} from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { pollDeposit, registerWatcherHooks, setWatcherDeps } from '../checkout/watcher.js';
import { createStore } from '../merchants/signup.js';
import { pollNativePayouts } from './native-payouts.js';
import { registerRefundHooks, sweepReturns } from '../checkout/refunds.js';

const SOL = '7SEYS3n5AWC3B6aXUp2TycE2eUYyDCX8x6Koc8qSLRLt';
const DEST = '0x1111111111111111111111111111111111111111';
const HASH = '5M9xKKwtMCyXopwuwz4LhejnoXD2XVYHyWiu64AVrtvD';
const DEBIT = 'BxD8rWUyFsoybutxbx8BiPZLGgtkmz2dgfuqg1j8q29o';
const SOL_TX =
  '4hWKtv8Gfqih3uBsb9XhqJPG4FjHdaNjCQxUhjS2H9qSeDn8KnWDJW79FHGq9G6qdf5zVvCRzngVCYgFnfdZHYjo';
const BASE_TX = `0x${'ab'.repeat(32)}`;
const pending = (): StatusResponse => ({
  status: 'PENDING_DEPOSIT',
  swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [] },
});

describe('Tidepool dashboard and checkout integration', () => {
  let app: FastifyInstance;
  let login: Login;
  let merchantId: string;
  let auth: SoftAuthenticator;
  let status: StatusResponse;
  const headers = (livemode = false) => dashHeaders(login, { merchantId, livemode });
  const post = (path: string, payload: object = {}) =>
    app.inject({ method: 'POST', url: path, headers: headers(), payload });

  beforeEach(async () => {
    await resetDb();
    vi.stubEnv('TEST_PAYMENT_PROVIDER', 'tidepool');
    vi.stubEnv('LIVE_ACCOUNT_DRIVER', 'native_intents');
    vi.stubEnv('LIVE_MODE_ENABLED', 'false');
    loadEnv();
    resetNearClients();
    resetTokenCache();
    resetOneClickProviders();
    setWatcherDeps(null);
    registerWatcherHooks();
    registerRefundHooks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    status = pending();
    auth = new SoftAuthenticator();
    login = await loginAs((await createUser({ emailVerifiedAt: new Date() })).id);
    merchantId = (await createMerchant({ defaultFeePayer: 'payer', defaultGasPayer: 'buyer' })).id;
    await createRow('MerchantUser', merchantId, false, {
      userId: login.userId,
      role: 'owner',
      isSigner: true,
    });
    vi.spyOn(HttpOneClick.prototype, 'tokens').mockResolvedValue(
      Object.values(T).map((t) => ({ ...t, decimals: 6, priceUsd: '1' })),
    );
    vi.spyOn(HttpOneClick.prototype, 'quote').mockImplementation(async (req) => ({
      correlationId: randomBytes(8).toString('hex'),
      quote: {
        amountIn: req.amount,
        amountOut: req.amount,
        minAmountOut: req.amount,
        amountInUsd: '1',
        amountOutUsd: '1',
        deadline: req.deadline,
        ...(req.dry
          ? {}
          : {
              depositAddress:
                req.depositType === 'INTENTS'
                  ? randomBytes(32).toString('hex')
                  : req.originAsset === T.baseUsdc.assetId
                    ? DEST
                    : SOL,
            }),
      },
    }));
    vi.spyOn(HttpOneClick.prototype, 'status').mockImplementation(async () => status);
    vi.spyOn(HttpOneClick.prototype, 'submitIntent').mockResolvedValue('tidepool-intent');
    fakeNearClient(false).scriptView(V, 'simulate_intents', () => ({ intents_executed: [{}] }));
    fakeNearClient(false).scriptView(V, 'mt_batch_balance_of', (args) =>
      (args as { token_ids: string[] }).token_ids.map(() => '0'),
    );
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    setWatcherDeps(null);
    resetNearClients();
    resetTokenCache();
    resetOneClickProviders();
    loadEnv();
  });

  async function activate() {
    const options = await post('/v1/account/native/passkey/options');
    expect(options.statusCode, options.body).toBe(200);
    expect(Buffer.from(options.json().user.id, 'base64url').toString()).toBe(`${merchantId}:test`);
    const registered = await post('/v1/account/native/passkey/verify', {
      response: auth.create(options.json()),
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const activated = await post('/v1/account/native/activate', {
      response: auth.get(registered.json().options),
    });
    expect(activated.statusCode, activated.body).toBe(200);
    return activated.json() as { nearAccountId: string };
  }
  async function checkout(options: { manual?: boolean; originAsset?: string } = {}) {
    const key = (await createApiKey(merchantId, { livemode: false })).raw;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        amount: '1.00',
        amount_currency: 'USD',
        external_ref: randomBytes(8).toString('hex'),
        success_url: 'https://shop.example/thanks',
        cancel_url: 'https://shop.example/cart',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const session = res.json() as { id: string; client_secret: string };
    const shopper = (method: 'GET' | 'POST', path: string, payload?: object) =>
      app.inject({
        method,
        url: `/v1/checkout/client/${path}`,
        headers: { authorization: `Bearer ${session.client_secret}` },
        ...(payload ? { payload } : {}),
      });
    const q = await shopper('POST', 'quote', {
      origin_asset: options.originAsset ?? T.solUsdc.assetId,
      ...(options.manual ? {} : { refund_address: SOL, refund_chain: 'sol' }),
    });
    expect(q.statusCode, q.body).toBe(201);
    return { session, shopper, quote: q.json() as { deposit_address: string; id: string } };
  }
  function credit(hash: string, receiver: string, finalized: boolean) {
    fakeNearClient(false).scriptTxStatus(hash, {
      hash,
      finalized,
      topLevelOk: true,
      signerId: 'maker.testnet',
      receiverId: V,
      receipts: [
        {
          receiptId: `receipt-${hash}`,
          executorId: V,
          ok: true,
          logs: [
            eventLog('nep245', '1.0.0', 'mt_transfer', [
              {
                old_owner_id: 'maker.testnet',
                new_owner_id: receiver,
                token_ids: [T.nearUsdc.assetId],
                amounts: ['1000000'],
              },
            ]),
          ],
        },
      ],
    });
  }

  it('registers a separate Test wallet with Live disabled and settles only final, verified receipts once', async () => {
    const account = await activate();
    expect(await prisma.merchantAccount.count({ where: { merchantId, livemode: true } })).toBe(0);
    expect(await prisma.settlementConfig.findFirst({ where: { merchantId } })).toMatchObject({
      destAssetId: T.nearUsdc.assetId,
    });
    const { shopper, session, quote } = await checkout();
    expect((await shopper('GET', 'session')).json()).toMatchObject({
      livemode: false,
      test_provider: 'tidepool',
    });
    expect((await shopper('GET', 'tokens')).json().tokens).toHaveLength(6);
    const recommendations = await shopper('POST', 'ai/recommendations', {
      assets: [{ asset_id: T.solUsdc.assetId }],
    });
    expect(recommendations.statusCode, recommendations.body).toBe(200);
    expect(recommendations.json()).toMatchObject({ source: 'testnet_quotes' });
    expect(recommendations.json().routes).toHaveLength(1);
    expect((await shopper('POST', 'simulate', { scenario: 'exact' })).statusCode).toBe(404);
    expect(() => simulatedOneClick()).toThrow('Simulation is disabled');
    expect((await shopper('POST', 'quote', { origin_asset: 'nep141:usdc.near' })).statusCode).toBe(
      400,
    );
    expect(await prisma.quote.findFirst({ where: { sessionId: session.id } })).toMatchObject({
      testProvider: 'tidepool',
    });
    status = {
      status: 'SUCCESS',
      swapDetails: {
        originChainTxHashes: [{ hash: SOL_TX }],
        destinationChainTxHashes: [{ hash: SOL_TX }, { hash: HASH }],
        amountIn: '1000000',
        depositedAmount: '1000000',
        amountOut: '1000000',
      },
    };
    credit(HASH, account.nearAccountId, false);
    await pollDeposit(quote.deposit_address, { livemode: false });
    expect(await prisma.event.count({ where: { merchantId, type: 'payment.succeeded' } })).toBe(0);
    credit(HASH, account.nearAccountId, true);
    await pollDeposit(quote.deposit_address, { livemode: false });
    await pollDeposit(quote.deposit_address, { livemode: false });
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toMatchObject({
      status: 'SETTLED',
      feeBps: 0,
    });
    expect(
      await prisma.event.count({
        where: { merchantId, type: 'payment.succeeded', livemode: false },
      }),
    ).toBe(1);
    expect(fakeNearClient(true).calls).toHaveLength(0);
  });

  it('keeps a partial Tidepool deposit open and reduces the same-address top-up until verified settlement', async () => {
    const account = await activate();
    const { shopper, session, quote } = await checkout();
    for (const amount of ['400000', '700000']) {
      status = {
        status: 'INCOMPLETE_DEPOSIT',
        swapDetails: {
          depositedAmount: amount,
          originChainTxHashes: [],
          destinationChainTxHashes: [],
        },
      };
      await pollDeposit(quote.deposit_address, { livemode: false });
      const view = (await shopper('GET', 'session')).json();
      expect(view.status).toBe('PROCESSING');
      expect(view.payments).toHaveLength(1);
      expect(view.payments[0]).toMatchObject({ state: 'underpaid', amount_received: amount });
      expect(view.topup).toMatchObject({
        deposit_address: quote.deposit_address,
        remaining_amount: String(1_000_000 - Number(amount)),
        message: `Send the remaining ${amount === '400000' ? '0.6' : '0.3'} USDC to the same address`,
      });
      expect(view.quote.id).toBe(quote.id);
      expect((await shopper('POST', 'quote', { origin_asset: T.solUsdc.assetId })).statusCode).toBe(
        409,
      );
    }
    expect(await prisma.quote.count({ where: { sessionId: session.id } })).toBe(1);
    expect(await prisma.quote.findUnique({ where: { id: quote.id } })).toMatchObject({
      supersededAt: null,
    });
    expect(await prisma.event.count({ where: { merchantId, type: 'payment.succeeded' } })).toBe(0);

    status = {
      status: 'SUCCESS',
      swapDetails: {
        depositedAmount: '1000000',
        amountIn: '1000000',
        amountOut: '1000000',
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: HASH }],
      },
    };
    credit(HASH, account.nearAccountId, true);
    await pollDeposit(quote.deposit_address, { livemode: false });
    await pollDeposit(quote.deposit_address, { livemode: false });
    expect((await shopper('GET', 'session')).json()).toMatchObject({
      status: 'SETTLED',
      topup: null,
    });
    expect(await prisma.event.count({ where: { merchantId, type: 'payment.succeeded' } })).toBe(1);
  });

  it('removes Tidepool top-ups at the deadline and records the provider refund without settling', async () => {
    await activate();
    const { shopper, quote } = await checkout();
    status = {
      status: 'INCOMPLETE_DEPOSIT',
      swapDetails: {
        depositedAmount: '500000',
        originChainTxHashes: [],
        destinationChainTxHashes: [],
      },
    };
    await pollDeposit(quote.deposit_address, { livemode: false });
    const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    setWatcherDeps({ now: () => new Date(row.deadline.getTime() + 1) });
    expect((await shopper('GET', 'session')).json().topup).toBeNull();
    await pollDeposit(quote.deposit_address, { livemode: false });
    expect(await prisma.quote.findUnique({ where: { id: quote.id } })).toMatchObject({
      supersededAt: expect.any(Date),
    });
    status = {
      status: 'REFUNDED',
      swapDetails: {
        ...status.swapDetails,
        refundedAmount: '500000',
        refundReason: 'PARTIAL_DEPOSIT',
      },
    };
    await pollDeposit(quote.deposit_address, { livemode: false });
    await pollDeposit(quote.deposit_address, { livemode: false });
    expect((await shopper('GET', 'session')).json()).toMatchObject({
      topup: null,
      payments: [expect.objectContaining({ state: 'refunded', refunded_amount: '500000' })],
    });
    expect(await prisma.event.count({ where: { merchantId, type: 'payment.succeeded' } })).toBe(0);
    expect(await prisma.event.count({ where: { merchantId, type: 'payment.refunded' } })).toBe(1);
  });

  it('honors disabled top-ups and never offers a superseded Tidepool address after re-enabling', async () => {
    await activate();
    const { shopper, quote } = await checkout();
    vi.stubEnv('CHECKOUT_TOPUP_ENABLED', 'false');
    loadEnv();
    status = {
      status: 'INCOMPLETE_DEPOSIT',
      swapDetails: {
        depositedAmount: '500000',
        originChainTxHashes: [],
        destinationChainTxHashes: [],
      },
    };
    await pollDeposit(quote.deposit_address, { livemode: false });
    expect((await shopper('GET', 'session')).json()).toMatchObject({
      status: 'PENDING_DEPOSIT',
      topup: null,
    });
    vi.stubEnv('CHECKOUT_TOPUP_ENABLED', 'true');
    loadEnv();
    expect((await shopper('GET', 'session')).json().topup).toBeNull();
  });

  it.each([
    [T.solUsdc.assetId, 'sol', SOL],
    [T.baseUsdc.assetId, 'base', DEST],
  ])(
    'collects a manual overpayment return address even without sender metadata, then prepares an owner-approved Test refund (%s)',
    async (originAsset, chain, address) => {
      const account = await activate();
      const { shopper, quote } = await checkout({ manual: true, originAsset });
      status = {
        status: 'SUCCESS',
        swapDetails: {
          depositedAmount: '4000000',
          amountIn: '1000000',
          amountOut: '1000000',
          refundedAmount: '3000000',
          originChainTxHashes: [],
          destinationChainTxHashes: [{ hash: HASH }],
        },
      };
      credit(HASH, account.nearAccountId, true);
      await pollDeposit(quote.deposit_address, { livemode: false });
      await sweepReturns();
      const view = (await shopper('GET', 'session')).json();
      expect(view.status).toBe('SETTLED');
      expect(view.refunds).toHaveLength(1);
      expect(view.refunds[0]).toMatchObject({
        needs_address: true,
        chains: [chain],
        state: 'processing',
      });
      expect(await prisma.accountProposal.count({ where: { merchantId } })).toBe(0);
      const wrongNetwork = await shopper('POST', 'refund-address', {
        refund_id: view.refunds[0].id,
        address: 'receiver.testnet',
        chain: 'near',
      });
      expect(wrongNetwork.statusCode).toBe(400);
      const filled = await shopper('POST', 'refund-address', {
        refund_id: view.refunds[0].id,
        address,
        chain,
      });
      expect(filled.statusCode, filled.body).toBe(200);
      expect(filled.json().status).toBe('pending_approval');
      const refund = await prisma.refund.findUniqueOrThrow({ where: { id: view.refunds[0].id } });
      expect(refund).toMatchObject({
        needsAddress: false,
        destination: address,
        destinationChain: chain,
        reviewReason: null,
      });
      fakeNearClient(false).scriptView(V, 'mt_batch_balance_of', () => ['4000000']);
      const payout = await post('/v1/account/native/payouts', { proposalId: refund.proposalId });
      expect(payout.statusCode, payout.body).toBe(201);
      expect(payout.json()).toMatchObject({
        destination: address,
        proposalId: refund.proposalId,
        status: 'awaiting_signature',
      });
      expect(
        await prisma.event.count({ where: { merchantId, type: 'refund.needs_address' } }),
      ).toBe(1);
      expect(await prisma.event.count({ where: { merchantId, type: 'refund.sent' } })).toBe(0);
    },
  );

  it('records a connected-wallet excess return without asking for an address or drafting another transfer', async () => {
    const account = await activate();
    const { shopper, quote } = await checkout();
    status = {
      status: 'SUCCESS',
      swapDetails: {
        depositedAmount: '4000000',
        amountIn: '1000000',
        amountOut: '1000000',
        refundedAmount: '3000000',
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: HASH }],
      },
    };
    credit(HASH, account.nearAccountId, true);
    await pollDeposit(quote.deposit_address, { livemode: false });
    await sweepReturns();
    const view = (await shopper('GET', 'session')).json();
    expect(view.refunds).toEqual([
      expect.objectContaining({ needs_address: false, state: 'sent' }),
    ]);
    expect(await prisma.accountProposal.count({ where: { merchantId } })).toBe(0);
  });

  it('requires a final verifier debit and the correct Base token receipt before completing a signed withdrawal', async () => {
    await activate();
    fakeNearClient(false).scriptView(V, 'mt_batch_balance_of', () => ['1000000']);
    const quoted = await post('/v1/account/native/payouts', {
      asset: T.nearUsdc.assetId,
      amount: '1000000',
      destinationAsset: T.baseUsdt.assetId,
      destination: DEST,
    });
    expect(quoted.statusCode, quoted.body).toBe(201);
    const payout = quoted.json();
    const challenge = await post(`/v1/account/native/payouts/${payout.id}/challenge`);
    expect(JSON.parse(challenge.json().payload).verifying_contract).toBe(V);
    const submitted = await post(`/v1/account/native/payouts/${payout.id}/submit`, {
      response: auth.get(challenge.json().options),
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const row = await prisma.nativePayout.findUniqueOrThrow({ where: { id: payout.id } });
    status = {
      status: 'SUCCESS',
      swapDetails: {
        originChainTxHashes: [{ hash: DEBIT }],
        destinationChainTxHashes: [{ hash: HASH }, { hash: BASE_TX }],
        amountOut: '1000000',
      },
    };
    const payload = JSON.parse(row.payload);
    const debit = (nonce: string) =>
      fakeNearClient(false).scriptTxStatus(DEBIT, {
        hash: DEBIT,
        finalized: true,
        topLevelOk: true,
        signerId: 'relayer.testnet',
        receiverId: V,
        receipts: [
          {
            receiptId: 'debit-receipt',
            executorId: V,
            ok: true,
            logs: [
              eventLog('nep245', '1.0.0', 'mt_transfer', [
                {
                  old_owner_id: payload.signer_id,
                  new_owner_id: row.depositAddress,
                  token_ids: [row.asset],
                  amounts: [row.amount],
                },
              ]),
              eventLog('dip4', '0.4.3', 'transfer', [
                {
                  account_id: payload.signer_id,
                  receiver_id: row.depositAddress,
                  tokens: { [row.asset]: row.amount },
                  intent_hash: row.intentHash,
                },
              ]),
              eventLog('dip4', '0.4.3', 'intents_executed', [
                { account_id: payload.signer_id, nonce, intent_hash: row.intentHash },
              ]),
            ],
          },
        ],
      });
    debit('different-nonce');
    let tokenContract: string = T.baseUsdc.contract;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const method = JSON.parse(init.body).method;
        return Response.json({
          result:
            method === 'eth_chainId'
              ? '0x14a34'
              : method === 'eth_blockNumber'
                ? '0x101'
                : {
                    status: '0x1',
                    blockNumber: '0x100',
                    logs: [
                      {
                        address: tokenContract,
                        topics: [
                          id('Transfer(address,address,uint256)'),
                          `0x${'0'.repeat(64)}`,
                          `0x${DEST.slice(2).padStart(64, '0')}`,
                        ],
                        data: `0x${(1_000_000).toString(16).padStart(64, '0')}`,
                      },
                    ],
                  },
        });
      }),
    );
    await pollNativePayouts();
    expect(await prisma.nativePayout.findUnique({ where: { id: payout.id } })).toMatchObject({
      status: 'submitted',
    });
    tokenContract = T.baseUsdt.contract;
    await pollNativePayouts();
    expect(await prisma.nativePayout.findUnique({ where: { id: payout.id } })).toMatchObject({
      status: 'submitted',
    });
    debit(payload.nonce);
    await pollNativePayouts();
    expect(await prisma.nativePayout.findUnique({ where: { id: payout.id } })).toMatchObject({
      status: 'completed',
    });
    expect(HttpOneClick.prototype.submitIntent).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/account/native/payouts/${payout.id}`,
          headers: headers(true),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('replaces only an absent, unfunded legacy identity and records its previous address', async () => {
    const old = await createRow('MerchantAccount', merchantId, false, {
      status: 'failed',
      nearAccountId: 'old.tendr.testnet',
    });
    await activate();
    expect(await prisma.merchantAccount.findUnique({ where: { id: old.id } })).toMatchObject({
      kind: 'native_intents',
      status: 'active',
    });
    expect(
      await prisma.event.findFirst({
        where: { merchantId, type: 'merchant_account.legacy_test_replaced' },
      }),
    ).toBeTruthy();
  });

  it('preserves a legacy identity that has funds or an active provisioning lease', async () => {
    const old = await createRow('MerchantAccount', merchantId, false, {
      status: 'failed',
      nearAccountId: 'old.tendr.testnet',
    });
    fakeNearClient(false).scriptView(V, 'mt_batch_balance_of', () => [
      '1',
      '0',
      '0',
      '0',
      '0',
      '0',
    ]);
    expect((await post('/v1/account/native/passkey/options')).statusCode).toBe(409);
    await prisma.merchantAccount.update({
      where: { id: old.id },
      data: { provisionClaimedAt: new Date() },
    });
    expect((await post('/v1/account/native/passkey/options')).statusCode).toBe(409);
    expect(await prisma.nativeWallet.count()).toBe(0);
  });

  it('does not auto-provision a NEAR contract for newly created stores', async () => {
    await createCredential(login.userId);
    const store = await createStore(login.userId, 'Tidepool store');
    expect(store.testAccount).toBeNull();
    expect(await prisma.merchantAccount.count({ where: { merchantId: store.merchant.id } })).toBe(
      0,
    );
    expect(
      await prisma.event.count({
        where: { merchantId: store.merchant.id, type: 'merchant_account.provision_requested' },
      }),
    ).toBe(0);
  });
});
