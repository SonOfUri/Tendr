import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loadEnv } from '../env.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { createMerchant, createUser, createRow, resetDb, setLiveMode } from '../test/helpers.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { registrationOptions, verifyRegistration } from '../auth/webauthn.js';
import {
  HttpOneClick,
  resetOneClickProviders,
  type QuoteRequest,
  type StatusResponse,
} from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { createSystemDraft } from './proposals.js';
import { getBalances, provisionMerchantAccount, mirrorTestSigners } from './accounts.js';
import { reconcileAccount } from './watcher.js';
import { enqueueReconciles } from '../jobs/account-notices.js';
import {
  nativeAccountId,
  validateTransferPayload,
  type NativeSignedIntent,
} from './native-signing.js';
import { pollNativePayouts, setNativePayoutDeps } from './native-payouts.js';
import { onRefundProposalExecuted } from '../checkout/refunds.js';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const DEST = '0x1111111111111111111111111111111111111111';
const transfer = (signer: string, deposit: string, asset = USDC, amount = '1000000') =>
  JSON.stringify({
    signer_id: signer,
    verifying_contract: 'intents.near',
    nonce: randomBytes(32).toString('base64'),
    deadline: new Date(Date.now() + 300_000).toISOString(),
    intents: [{ intent: 'transfer', receiver_id: deposit, tokens: { [asset]: amount } }],
  });

describe('native passkey wallet API', () => {
  let app: FastifyInstance;
  let login: Login;
  let merchantId: string;
  let auth: SoftAuthenticator;
  let status: StatusResponse;
  let lastQuote: QuoteRequest;
  const submit = vi.fn(async (_signed: NativeSignedIntent) => 'intent-hash');
  const generate = vi.fn(async (signer: string, deposit: string) =>
    transfer(signer, deposit, lastQuote.originAsset, lastQuote.amount),
  );
  const screen = vi.fn(async () => 'allow' as 'allow' | 'block' | 'unavailable');
  const headers = () => dashHeaders(login, { merchantId, livemode: true });
  const post = (url: string, payload: unknown = {}, customHeaders = headers()) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers: customHeaders });
  const base = '/v1/account/native';

  beforeEach(async () => {
    await resetDb();
    resetNearClients();
    resetTokenCache();
    resetOneClickProviders();
    process.env.LIVE_ACCOUNT_DRIVER = 'native_intents';
    setLiveMode(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await createUser({ emailVerifiedAt: new Date() });
    login = await loginAs(user.id);
    merchantId = (await createMerchant({ slug: 'native-shop', defaultGasPayer: 'buyer' })).id;
    await createRow('MerchantUser', merchantId, false, {
      userId: user.id,
      role: 'owner',
      isSigner: true,
    });
    auth = new SoftAuthenticator();
    status = {
      status: 'PENDING_DEPOSIT',
      swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [] },
    };
    submit.mockReset().mockResolvedValue('intent-hash');
    generate.mockClear();
    screen.mockReset().mockResolvedValue('allow');
    setNativePayoutDeps({
      screen,
      provider: () => ({
        quote: async (req) => {
          lastQuote = req;
          return {
            correlationId: 'quote-1',
            quote: {
              depositAddress: randomBytes(32).toString('hex'),
              amountIn: req.amount,
              amountOut: '990000',
              amountInUsd: '1',
              amountOutUsd: '0.99',
              minAmountOut: '980000',
            },
          };
        },
        generateIntent: generate,
        submitIntent: submit,
        status: async () => status,
      }),
    });
    vi.spyOn(HttpOneClick.prototype, 'tokens').mockResolvedValue([
      { assetId: USDC, blockchain: 'near', decimals: 6, symbol: 'USDC', priceUsd: '1' },
      { assetId: BASE, blockchain: 'base', decimals: 6, symbol: 'USDC', priceUsd: '1' },
    ]);
    fakeNearClient(true).scriptView('intents.near', 'simulate_intents', () => ({
      intents_executed: [{}],
    }));
    fakeNearClient(true).scriptView('intents.near', 'mt_batch_balance_of', () => ['10000000']);
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    setNativePayoutDeps(null);
    resetNearClients();
    resetTokenCache();
    resetOneClickProviders();
    delete process.env.LIVE_ACCOUNT_DRIVER;
    setLiveMode(undefined);
    loadEnv();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function register() {
    const options = await post(`${base}/passkey/options`);
    expect(options.statusCode, options.body).toBe(200);
    const verified = await post(`${base}/passkey/verify`, {
      response: auth.create(options.json()),
    });
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.json();
  }
  async function activate() {
    const registration = await register();
    const activated = await post(`${base}/activate`, { response: auth.get(registration.options) });
    expect(activated.statusCode, activated.body).toBe(200);
    return activated.json();
  }
  async function quote() {
    const result = await post(`${base}/payouts`, {
      asset: USDC,
      amount: '1000000',
      destinationAsset: BASE,
      destination: DEST,
    });
    expect(result.statusCode, result.body).toBe(201);
    return result.json();
  }

  it('activates only after proof, installs default settlement, and never provisions, mirrors or tops up', async () => {
    const r = await register();
    expect(
      await prisma.merchantAccount.findFirst({ where: { merchantId, livemode: true } }),
    ).toMatchObject({ status: 'provisioning', kind: 'native_intents', contractCodeHash: null });
    expect(await prisma.settlementConfig.count({ where: { merchantId } })).toBe(0);
    const wrong = new SoftAuthenticator();
    wrong.credentialId = auth.credentialId;
    expect((await post(`${base}/activate`, { response: wrong.get(r.options) })).statusCode).toBe(
      400,
    );
    const res = await post(`${base}/activate`, { response: auth.get(r.options) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'native_intents',
      status: 'active',
      capabilities: {
        multisig: false,
        timedRecovery: false,
        contractLimits: false,
        autoSweep: false,
      },
    });
    expect(await prisma.settlementConfig.findFirst({ where: { merchantId } })).toMatchObject({
      destAssetId: USDC,
      payoutMode: 'intents',
    });
    expect(await provisionMerchantAccount(merchantId, true)).toMatchObject({ status: 'active' });
    expect(await reconcileAccount(merchantId, true)).toBe(false);
    expect(await mirrorTestSigners(merchantId)).toEqual({ synced: false });
    expect(await enqueueReconciles()).toBe(0);
    expect(fakeNearClient(true).calls.every((c) => c.kind === 'view')).toBe(true);
    expect(
      await prisma.event.count({
        where: { merchantId, type: 'merchant_account.provision_requested' },
      }),
    ).toBe(0);
    const view = await app.inject({ method: 'GET', url: '/v1/account', headers: headers() });
    expect(view.json().signers).toMatchObject([{ userId: login.userId, keys: 1 }]);
    const go = await app.inject({ method: 'GET', url: '/v1/account/go-live', headers: headers() });
    expect(go.json().checklist.ok).toBe(true);
  });

  it('isolates store balances; rejects reused credentials and registration challenge replay', async () => {
    const opts = await post(`${base}/passkey/options`);
    const response = auth.create(opts.json());
    const first = await post(`${base}/passkey/verify`, { response });
    expect(first.statusCode).toBe(200);
    expect((await post(`${base}/passkey/verify`, { response })).statusCode).toBe(400);
    const previous = merchantId;
    merchantId = (await createMerchant()).id;
    await createRow('MerchantUser', merchantId, false, { userId: login.userId, role: 'owner' });
    auth.credentialId = randomBytes(16); // same public key under a new credential ID is still forbidden
    const opts2 = await post(`${base}/passkey/options`);
    expect(opts2.json().user.id).not.toBe(opts.json().user.id);
    expect(
      (await post(`${base}/passkey/verify`, { response: auth.create(opts2.json()) })).statusCode,
    ).toBe(409);
    auth = new SoftAuthenticator();
    const second = await activate();
    expect(second.nearAccountId).not.toBe(first.json().accountId);
    expect(await prisma.merchantAccount.count({ where: { merchantId: previous } })).toBe(1);
  });

  it('refuses login passkeys, wrong origins, missing UV and stale activation challenges', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: login.userId } });
    await verifyRegistration(user, auth.create(await registrationOptions(user)), null);
    login = await loginAs(user.id);
    const opts = await post(`${base}/passkey/options`);
    expect(
      (await post(`${base}/passkey/verify`, { response: auth.create(opts.json()) })).statusCode,
    ).toBe(409);
    auth = new SoftAuthenticator();
    const r = await register();
    expect(
      (
        await post(`${base}/activate`, {
          response: auth.assert(r.options.challenge, { origin: 'https://evil.example' }),
        })
      ).statusCode,
    ).toBe(400);
    auth.userVerified = false;
    expect((await post(`${base}/activate`, { response: auth.get(r.options) })).statusCode).toBe(
      400,
    );
    auth.userVerified = true;
    const newer = await post(`${base}/activate/options`);
    expect((await post(`${base}/activate`, { response: auth.get(r.options) })).statusCode).toBe(
      400,
    );
    expect(
      (await post(`${base}/activate`, { response: auth.get(newer.json().options) })).statusCode,
    ).toBe(200);
  });

  it('enforces owner, step-up, live switch and mode boundaries', async () => {
    expect(
      (
        await post(
          `${base}/passkey/options`,
          {},
          dashHeaders(login, { merchantId, livemode: false }),
        )
      ).statusCode,
    ).toBe(409);
    const stale = await loginAs(login.userId, { stepUp: false });
    expect(
      (
        await post(
          `${base}/passkey/options`,
          {},
          dashHeaders(stale, { merchantId, livemode: true }),
        )
      ).statusCode,
    ).toBe(401);
    const other = await createUser();
    await createRow('MerchantUser', merchantId, false, { userId: other.id, role: 'admin' });
    expect(
      (
        await post(
          `${base}/passkey/options`,
          {},
          dashHeaders(await loginAs(other.id), { merchantId, livemode: true }),
        )
      ).statusCode,
    ).toBe(403);
    setLiveMode(false);
    expect((await post(`${base}/passkey/options`)).statusCode).toBe(403);
  });

  it('rejects contract-only settings and supports native default settlement', async () => {
    await activate();
    for (const action of [
      { set_threshold: 2 },
      { set_limits: { asset: USDC, per_tx: '1', per_day: null } },
    ]) {
      expect((await post('/v1/account/proposals', { action })).statusCode).toBe(409);
    }
    expect((await post('/v1/account/retry')).statusCode).toBe(409);
    const res = await app.inject({
      method: 'PUT',
      url: `${base}/settlement`,
      headers: headers(),
      payload: { asset: BASE },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.settlementConfig.count({ where: { merchantId, isDefault: true } })).toBe(1);
    expect(
      await prisma.settlementConfig.findFirst({ where: { merchantId, isDefault: true } }),
    ).toMatchObject({ destAssetId: BASE, payoutMode: 'intents' });
  });

  it('signs the exact payout, persists before submission, prevents replay and reconciles completion', async () => {
    const account = await activate();
    const p = await quote();
    expect(lastQuote).toMatchObject({
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      refundTo: account.nearAccountId,
      recipientType: 'DESTINATION_CHAIN',
      recipient: DEST,
    });
    const challenge = await post(`${base}/payouts/${p.id}/challenge`);
    const response = auth.get(challenge.json().options);
    submit.mockImplementationOnce(async (signed) => {
      expect(await prisma.nativePayout.findUnique({ where: { id: p.id } })).toMatchObject({
        status: 'submitting',
        signature: signed,
      });
      return 'intent-hash';
    });
    const sent = await post(`${base}/payouts/${p.id}/submit`, { response });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(sent.json().status).toBe('submitted');
    await post(`${base}/payouts/${p.id}/submit`, { response });
    expect(submit).toHaveBeenCalledTimes(1);
    const p2 = await quote();
    expect((await post(`${base}/payouts/${p2.id}/submit`, { response })).statusCode).toBe(400);
    status = {
      status: 'SUCCESS',
      swapDetails: {
        originChainTxHashes: [{ hash: 'near-intent' }],
        destinationChainTxHashes: [{ hash: 'base-transfer' }],
      },
    };
    await pollNativePayouts();
    await pollNativePayouts();
    expect(await prisma.nativePayout.findUnique({ where: { id: p.id } })).toMatchObject({
      status: 'completed',
    });
    expect(
      await prisma.event.count({ where: { aggregateId: p.id, type: 'native_payout.completed' } }),
    ).toBe(1);
  });

  it('retries an unknown outcome with identical signed bytes and never a new nonce', async () => {
    await activate();
    const p = await quote();
    const challenge = await post(`${base}/payouts/${p.id}/challenge`);
    submit.mockRejectedValueOnce(new Error('timeout after acceptance'));
    const result = await post(`${base}/payouts/${p.id}/submit`, {
      response: auth.get(challenge.json().options),
    });
    expect(result.json().status).toBe('submitting');
    await pollNativePayouts();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('fails closed on screening, malicious provider payloads, insufficient balance and expiry', async () => {
    await activate();
    screen.mockResolvedValueOnce('unavailable');
    expect(
      (
        await post(`${base}/payouts`, {
          asset: USDC,
          amount: '1000000',
          destinationAsset: BASE,
          destination: DEST,
        })
      ).statusCode,
    ).toBe(503);
    const p = await quote();
    const challenge = await post(`${base}/payouts/${p.id}/challenge`);
    screen.mockResolvedValueOnce('block');
    expect(
      (
        await post(`${base}/payouts/${p.id}/submit`, {
          response: auth.get(challenge.json().options),
        })
      ).statusCode,
    ).toBe(400);
    expect(submit).not.toHaveBeenCalled();
    fakeNearClient(true).scriptView('intents.near', 'mt_batch_balance_of', () => ['0']);
    expect(
      (
        await post(`${base}/payouts`, {
          asset: USDC,
          amount: '1000000',
          destinationAsset: BASE,
          destination: DEST,
        })
      ).statusCode,
    ).toBe(409);
    await prisma.nativePayout.update({ where: { id: p.id }, data: { expiresAt: new Date(0) } });
    expect((await post(`${base}/payouts/${p.id}/challenge`)).statusCode).toBe(409);
    const payload = transfer('signer', 'deposit');
    expect(() =>
      validateTransferPayload(payload, {
        signerId: 'signer',
        depositAddress: 'attacker',
        asset: USDC,
        amount: '1000000',
        contract: 'intents.near',
      }),
    ).toThrow();
    const bad = JSON.parse(payload);
    bad.intents.push({ intent: 'add_public_key', public_key: 'p256:attacker' });
    expect(() =>
      validateTransferPayload(JSON.stringify(bad), {
        signerId: 'signer',
        depositAddress: 'deposit',
        asset: USDC,
        amount: '1000000',
        contract: 'intents.near',
      }),
    ).toThrow();
  });

  it('keeps other stores and co-owners from signing this wallet', async () => {
    await activate();
    const p = await quote();
    const other = await createUser();
    await createRow('MerchantUser', merchantId, false, { userId: other.id, role: 'owner' });
    const otherHeaders = dashHeaders(await loginAs(other.id), { merchantId, livemode: true });
    expect((await post(`${base}/payouts/${p.id}/challenge`, {}, otherHeaders)).statusCode).toBe(
      403,
    );
    const otherStore = await createMerchant();
    await createRow('MerchantUser', otherStore.id, false, { userId: login.userId, role: 'owner' });
    const foreign = await app.inject({
      method: 'GET',
      url: `${base}/payouts/${p.id}`,
      headers: dashHeaders(login, { merchantId: otherStore.id, livemode: true }),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('confirms a linked refund only after the destination transaction exists', async () => {
    await activate();
    const payment = await createRow('Payment', merchantId, true, { status: 'REFUNDING' });
    const refund = await createRow('Refund', merchantId, true, {
      paymentId: payment.id,
      assetId: BASE,
      amount: '1000000',
      destination: DEST,
      destinationChain: 'base',
      status: 'pending',
      needsAddress: false,
      reviewReason: null,
    });
    const proposal = await createSystemDraft(
      { merchantId, livemode: true },
      {
        kind: 'refund',
        reason: 'test',
        refundId: refund.id,
        action: {
          refund: {
            asset: BASE,
            amount: '1000000',
            destination_chain: 'base',
            destination: DEST,
            payment_id: payment.id,
            route: { poa: { token_contract: BASE.slice(7) } },
          },
        },
      },
    );
    await prisma.refund.update({ where: { id: refund.id }, data: { proposalId: proposal.id } });
    const q = await post(`${base}/payouts`, { proposalId: proposal.id });
    expect(q.statusCode, q.body).toBe(201);
    const p = q.json();
    const challenge = await post(`${base}/payouts/${p.id}/challenge`);
    expect(
      (
        await post(`${base}/payouts/${p.id}/submit`, {
          response: auth.get(challenge.json().options),
        })
      ).statusCode,
    ).toBe(202);
    status = {
      status: 'SUCCESS',
      swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [] },
    };
    await pollNativePayouts();
    expect(await prisma.accountProposal.findUnique({ where: { id: proposal.id } })).toMatchObject({
      status: 'executing',
    });
    status.swapDetails.destinationChainTxHashes.push({ hash: 'refund-transfer' });
    await pollNativePayouts();
    const event = await prisma.event.findFirstOrThrow({
      where: { aggregateId: proposal.id, type: 'account.proposal.executed' },
    });
    await onRefundProposalExecuted(event);
    await onRefundProposalExecuted(event);
    expect(await prisma.refund.findUnique({ where: { id: refund.id } })).toMatchObject({
      status: 'confirmed',
      refundTxHash: 'refund-transfer',
    });
  });

  it('never migrates an existing contract account or patches its settlement through native routes', async () => {
    const account = await createRow('MerchantAccount', merchantId, true, { status: 'active' });
    expect((await post(`${base}/passkey/options`)).statusCode).toBe(409);
    const patch = await app.inject({
      method: 'PUT',
      url: `${base}/settlement`,
      headers: headers(),
      payload: { asset: BASE },
    });
    expect(patch.statusCode).toBe(403);
    expect(await prisma.merchantAccount.findUnique({ where: { id: account.id } })).toMatchObject({
      kind: 'contract',
    });
    expect(await prisma.nativeWallet.count()).toBe(0);
  });

  it('does not release a failed payout while its signed intent is still executable', async () => {
    await activate();
    const p = await quote();
    const challenge = await post(`${base}/payouts/${p.id}/challenge`);
    await post(`${base}/payouts/${p.id}/submit`, { response: auth.get(challenge.json().options) });
    status = {
      status: 'FAILED',
      swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [] },
    };
    await pollNativePayouts();
    expect(await prisma.nativePayout.findUnique({ where: { id: p.id } })).toMatchObject({
      status: 'submitted',
    });
    await prisma.nativePayout.update({ where: { id: p.id }, data: { expiresAt: new Date(0) } });
    await pollNativePayouts();
    expect(await prisma.nativePayout.findUnique({ where: { id: p.id } })).toMatchObject({
      status: 'failed',
    });
  });

  it('lets the wallet owner cancel a draft refund without calling a contract', async () => {
    const account = await activate();
    const proposal = await createRow('AccountProposal', merchantId, true, {
      accountId: account.id,
      kind: 'refund',
      status: 'draft',
    });
    const result = await post(`/v1/account/proposals/${proposal.id}/cancel`);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().status).toBe('cancelled');
    expect(
      await prisma.event.count({
        where: { aggregateId: proposal.id, type: 'account.proposal.cancelled' },
      }),
    ).toBe(1);
    expect(fakeNearClient(true).calls.every((c) => c.kind === 'view')).toBe(true);
  });

  it('derives the protocol P256 test vector exactly', () => {
    expect(
      nativeAccountId(
        'p256:3aMVMxsoAnHUbweXMtdKaN1uJaNwsfKv7wnc97SDGjXhyK62VyJwhPUPLZefKVthcoUcuWK6cqkSU4M542ipNxS3',
      ),
    ).toBe('0x7edf07ede58238026db3f90fc8032633b69b8de5');
  });

  it('includes assets from per-link settlements in the balance read', async () => {
    await activate();
    await createRow('Session', merchantId, true, { destAsset: BASE });
    fakeNearClient(true).scriptView('intents.near', 'mt_batch_balance_of', (args) =>
      (args as { token_ids: string[] }).token_ids.map(() => '10'),
    );
    expect((await getBalances(merchantId, true)).balances.map((b) => b.asset)).toContain(BASE);
  });
});
