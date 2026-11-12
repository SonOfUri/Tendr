import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loadEnv } from '../env.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { createMerchant, createUser, createRow, resetDb, setLiveMode } from '../test/helpers.js';
import {
  dashHeaders,
  loginAs,
  responseCookies,
  tokenFromMail,
  type Login,
} from '../test/dashboard.js';
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
import { screenPayoutAddress } from '../checkout/screening.js';

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
    transfer(
      signer,
      deposit,
      lastQuote.originAsset,
      lastQuote.swapType === 'EXACT_OUTPUT' ? '1050000' : lastQuote.amount,
    ),
  );
  const screen = vi.fn(screenPayoutAddress);
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
              amountIn: req.swapType === 'EXACT_OUTPUT' ? '1050000' : req.amount,
              amountOut: req.swapType === 'EXACT_OUTPUT' ? req.amount : '990000',
              amountInUsd: '1',
              amountOutUsd: '0.99',
              minAmountOut: req.swapType === 'EXACT_OUTPUT' ? req.amount : '980000',
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
    vi.unstubAllEnvs();
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

  it('email login on another device keeps the existing live wallet without signing authority', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: login.userId } });
    const loginKey = new SoftAuthenticator();
    await verifyRegistration(user, loginKey.create(await registrationOptions(user)), 'Laptop');
    login = await loginAs(user.id);
    const account = await activate();
    const peopleBefore = await prisma.user.count();
    expect((await post('/v1/auth/email/start', { email: user.email }, {})).statusCode).toBe(202);
    const verified = await post(
      '/v1/auth/email/verify',
      {
        token: tokenFromMail(user.email, 'login_link'),
      },
      {},
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ user: { id: user.id }, hasPasskey: true });
    const cookies = responseCookies(verified.headers['set-cookie']);
    const second: Login = {
      userId: user.id,
      token: cookies.tendr_session!,
      csrf: cookies.tendr_csrf!,
    };
    expect(second.token).not.toBe(login.token);
    const secondHeaders = dashHeaders(second, { merchantId, livemode: true });
    for (const sessionHeaders of [headers(), secondHeaders]) {
      const view = await app.inject({ method: 'GET', url: '/v1/account', headers: sessionHeaders });
      expect(view.statusCode).toBe(200);
      expect(view.json()).toMatchObject({
        livemode: true,
        account: { id: account.id, nearAccountId: account.nearAccountId, status: 'active' },
        nativeWallet: { ownerUserId: user.id },
      });
      const balances = await app.inject({
        method: 'GET',
        url: '/v1/account/balances',
        headers: sessionHeaders,
      });
      expect(balances.statusCode).toBe(200);
      expect(balances.json().accountId).toBe(account.nearAccountId);
    }
    for (const path of [
      `${base}/passkey/options`,
      `${base}/payouts`,
      `${base}/payouts/npay_example/submit`,
    ]) {
      const denied = await post(path, {}, secondHeaders);
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.code).toBe('STEP_UP_REQUIRED');
    }
    expect(await prisma.user.count()).toBe(peopleBefore);
    expect(await prisma.merchantAccount.count({ where: { merchantId, livemode: true } })).toBe(1);
    expect(await prisma.nativeWallet.count({ where: { merchantId, livemode: true } })).toBe(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('allows a login authenticator to create distinct wallets for multiple stores', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: login.userId } });
    const loginOptions = await registrationOptions(user);
    const loginAuthenticator = new SoftAuthenticator();
    await verifyRegistration(user, loginAuthenticator.create(loginOptions), null);
    login = await loginAs(user.id);
    const handles = new Set([loginOptions.user.id]);
    const accountIds = new Set<string>();
    for (let i = 0; i < 2; i++) {
      if (i > 0) {
        merchantId = (await createMerchant()).id;
        await createRow('MerchantUser', merchantId, false, { userId: user.id, role: 'owner' });
      }
      const options = await post(`${base}/passkey/options`);
      expect(options.statusCode).toBe(200);
      // A real authenticator aborts creation if it holds ANY excluded credential, regardless
      // of user handle. Login and other-store keys must not block this new wallet ceremony.
      expect(options.json().excludeCredentials).toEqual([]);
      expect(handles.has(options.json().user.id)).toBe(false);
      handles.add(options.json().user.id);
      const walletKey = new SoftAuthenticator();
      const registered = await post(`${base}/passkey/verify`, {
        response: walletKey.create(options.json()),
      });
      expect(registered.statusCode, registered.body).toBe(200);
      accountIds.add(registered.json().accountId);
      expect((await post(`${base}/passkey/options`)).statusCode).toBe(409);
      expect(
        (await post(`${base}/activate`, { response: walletKey.get(registered.json().options) }))
          .statusCode,
      ).toBe(200);
    }
    expect(accountIds.size).toBe(2);
    expect(await prisma.webauthnCredential.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.nativeWallet.count({ where: { ownerUserId: user.id } })).toBe(2);
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

  it('quotes and submits signed payouts with explicitly skipped screening, then enforces screening when restored', async () => {
    vi.stubEnv('SCREENING_MODE', 'disabled');
    vi.stubEnv('CHAINALYSIS_API_KEY', '');
    loadEnv();
    screen.mockImplementation(screenPayoutAddress);
    await activate();
    const p = await quote();
    const challenge = await post(`${base}/payouts/${p.id}/challenge`);
    const response = auth.get(challenge.json().options);
    vi.stubEnv('SCREENING_MODE', 'chainalysis');
    loadEnv();
    expect((await post(`${base}/payouts/${p.id}/submit`, { response })).statusCode).toBe(503);
    expect(submit).not.toHaveBeenCalled();
    vi.stubEnv('SCREENING_MODE', 'disabled');
    loadEnv();
    const sent = await post(`${base}/payouts/${p.id}/submit`, { response });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      await prisma.event.count({
        where: { merchantId, type: 'merchant_account.payout_screening_skipped' },
      }),
    ).toBe(2);
    expect(
      await prisma.event.count({
        where: {
          merchantId,
          type: 'merchant_account.payout_screened',
          payload: { path: ['decision'], equals: 'allow' },
        },
      }),
    ).toBe(0);
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
  async function bill(status: 'open' | 'awaiting_verification' = 'open') {
    return createRow('Invoice', merchantId, true, {
      status,
      verifiedAt: status === 'open' ? new Date() : null,
      amount: '1000000',
      destinationAsset: BASE,
      destination: DEST,
      destinationChain: 'base',
    });
  }
  const invoiceQuote = (id: string) => post(`/v1/invoices/${id}/payout`, { asset: USDC });

  it.each([true, false])(
    'prices a USD invoice from a fresh rate and checks the signed token target after rates change (full delivery: %s)',
    async (full) => {
      await activate();
      const invoice = await bill();
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { amountCurrency: 'USD', amount: '100' },
      });
      // Activation populated the ordinary five-minute catalog cache at $1. The invoice must fetch $2.
      vi.mocked(HttpOneClick.prototype.tokens).mockResolvedValue([
        { assetId: USDC, blockchain: 'near', decimals: 6, symbol: 'USDC', priceUsd: '1' },
        { assetId: BASE, blockchain: 'base', decimals: 6, symbol: 'USDC', priceUsd: '2' },
      ]);
      const quoted = await invoiceQuote(invoice.id);
      expect(quoted.statusCode, quoted.body).toBe(201);
      expect(lastQuote).toMatchObject({ swapType: 'EXACT_OUTPUT', amount: '500000' });
      const payout = quoted.json();
      expect(payout.quote.invoicePricing).toMatchObject({
        amountCurrency: 'USD',
        amount: '100',
        destinationAmount: '500000',
        priceUsd: '2',
      });
      const challenge = (await post(`${base}/payouts/${payout.id}/challenge`)).json();
      await post(`${base}/payouts/${payout.id}/submit`, { response: auth.get(challenge.options) });
      vi.mocked(HttpOneClick.prototype.tokens).mockRejectedValue(
        new Error('Prices unavailable after signing'),
      );
      resetTokenCache();
      status = {
        status: 'SUCCESS',
        swapDetails: {
          amountOut: full ? '500000' : '400000',
          originChainTxHashes: [],
          destinationChainTxHashes: [{ hash: 'usd-invoice-tx' }],
        },
      };
      await pollNativePayouts();
      expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({
        amountCurrency: 'USD',
        amount: '100',
        status: full ? 'paid' : 'payment_review',
      });
    },
  );

  it('does not assume a dollar peg when the receiving token price is missing', async () => {
    await activate();
    const invoice = await bill();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { amountCurrency: 'USD', amount: '100' },
    });
    vi.mocked(HttpOneClick.prototype.tokens).mockResolvedValue([
      { assetId: USDC, blockchain: 'near', decimals: 6, symbol: 'USDC', priceUsd: '1' },
      { assetId: BASE, blockchain: 'base', decimals: 6, symbol: 'USDC' },
    ]);
    const result = await invoiceQuote(invoice.id);
    expect(result.statusCode, result.body).toBe(503);
    expect(result.body).toContain('current USD price');
    expect(await prisma.nativePayout.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });

  it('reprices an expired USD quote without changing the dollar invoice total', async () => {
    await activate();
    const invoice = await bill();
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { amountCurrency: 'USD', amount: '100' },
    });
    const first = (await invoiceQuote(invoice.id)).json();
    expect(first.quote.quote.amountOut).toBe('1000000');
    await prisma.nativePayout.update({ where: { id: first.id }, data: { expiresAt: new Date(0) } });
    vi.mocked(HttpOneClick.prototype.tokens).mockResolvedValue([
      { assetId: USDC, blockchain: 'near', decimals: 6, symbol: 'USDC', priceUsd: '1' },
      { assetId: BASE, blockchain: 'base', decimals: 6, symbol: 'USDC', priceUsd: '2' },
    ]);
    const second = (await invoiceQuote(invoice.id)).json();
    expect(second.id).not.toBe(first.id);
    expect(second.quote.quote.amountOut).toBe('500000');
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({
      amount: '100',
      amountCurrency: 'USD',
    });
  });

  it('quotes the exact invoice output and serializes concurrent attempts', async () => {
    await activate();
    const invoice = await bill();
    const results = await Promise.all([invoiceQuote(invoice.id), invoiceQuote(invoice.id)]);
    for (const r of results) expect(r.statusCode, r.body).toBe(201);
    expect(results[0]!.json().id).toBe(results[1]!.json().id);
    expect(results[0]!.json()).toMatchObject({
      amount: '1050000',
      destination: DEST,
      destinationAsset: BASE,
      invoiceId: invoice.id,
    });
    expect(lastQuote).toMatchObject({
      swapType: 'EXACT_OUTPUT',
      amount: '1000000',
      recipient: DEST,
    });
    expect(await prisma.nativePayout.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(
      (
        await post(`/v1/invoices/${invoice.id}/payout`, {
          asset: USDC,
          amount: '1',
          destination: 'attacker.near',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('keeps an uncertain invoice payment locked, retries the same signature, and records confirmed delivery', async () => {
    await activate();
    const invoice = await bill();
    const q = (await invoiceQuote(invoice.id)).json();
    const challenge = (await post(`${base}/payouts/${q.id}/challenge`)).json();
    const response = auth.get(challenge.options);
    submit.mockRejectedValueOnce(new Error('Timeout after acceptance'));
    expect((await post(`${base}/payouts/${q.id}/submit`, { response })).statusCode).toBe(202);
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({
      status: 'processing',
      paidAt: null,
    });
    expect((await invoiceQuote(invoice.id)).statusCode).toBe(409);
    expect((await post(`/v1/invoices/${invoice.id}/reject`)).statusCode).toBe(409);
    await pollNativePayouts();
    expect(submit.mock.calls[0]![0]).toEqual(submit.mock.calls[1]![0]);
    status = {
      status: 'SUCCESS',
      swapDetails: {
        amountOut: '1000000',
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: 'invoice-tx' }],
      },
    };
    await pollNativePayouts();
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({
      status: 'paid',
      paidAt: expect.any(Date),
    });
    expect((await invoiceQuote(invoice.id)).statusCode).toBe(409);
    expect(
      await prisma.event.count({ where: { aggregateId: invoice.id, type: 'invoice.paid' } }),
    ).toBe(1);
  });

  it('never treats an incomplete receipt as paid or permits another attempt', async () => {
    await activate();
    const invoice = await bill();
    const q = (await invoiceQuote(invoice.id)).json();
    const challenge = (await post(`${base}/payouts/${q.id}/challenge`)).json();
    await post(`${base}/payouts/${q.id}/submit`, { response: auth.get(challenge.options) });
    status = {
      status: 'SUCCESS',
      swapDetails: {
        amountOut: '900000',
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: 'short-tx' }],
      },
    };
    await pollNativePayouts();
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({
      status: 'payment_review',
      paidAt: null,
    });
    expect((await invoiceQuote(invoice.id)).statusCode).toBe(409);
  });

  it('invalidates an expired quote before replacement and a declined invoice before signing', async () => {
    await activate();
    const invoice = await bill();
    const q = (await invoiceQuote(invoice.id)).json();
    await prisma.nativePayout.update({
      where: { id: q.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const fresh = (await invoiceQuote(invoice.id)).json();
    expect(fresh.id).not.toBe(q.id);
    expect((await post(`${base}/payouts/${q.id}/challenge`)).statusCode).toBe(409);
    const challenge = (await post(`${base}/payouts/${fresh.id}/challenge`)).json();
    expect((await post(`/v1/invoices/${invoice.id}/reject`)).statusCode).toBe(200);
    await post(`${base}/payouts/${fresh.id}/submit`, { response: auth.get(challenge.options) });
    expect(submit).not.toHaveBeenCalled();
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).toMatchObject({
      status: 'rejected',
    });
  });

  it('requires verified invoices, the right merchant and mode, owner role, step-up and sufficient quoted balance', async () => {
    await activate();
    const draft = await bill('awaiting_verification');
    expect((await invoiceQuote(draft.id)).statusCode).toBe(409);
    const invoice = await bill();
    const other = await createMerchant();
    const foreign = await createRow('Invoice', other.id, true, {
      status: 'open',
      verifiedAt: new Date(),
    });
    expect((await invoiceQuote(foreign.id)).statusCode).toBe(404);
    const testHeaders = dashHeaders(login, { merchantId, livemode: false });
    expect(
      (await app.inject({ method: 'GET', url: `/v1/invoices/${invoice.id}`, headers: testHeaders }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(`/v1/invoices/${invoice.id}/payout`, { asset: USDC }, testHeaders)).statusCode,
    ).toBe(409);
    const admin = await createUser();
    await createRow('MerchantUser', merchantId, false, { userId: admin.id, role: 'admin' });
    expect(
      (
        await post(
          `/v1/invoices/${invoice.id}/payout`,
          { asset: USDC },
          dashHeaders(await loginAs(admin.id), { merchantId, livemode: true }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(
          `/v1/invoices/${invoice.id}/payout`,
          { asset: USDC },
          dashHeaders(await loginAs(login.userId, { stepUp: false }), {
            merchantId,
            livemode: true,
          }),
        )
      ).statusCode,
    ).toBe(401);
    fakeNearClient(true).scriptView('intents.near', 'mt_batch_balance_of', () => ['1000000']);
    expect((await invoiceQuote(invoice.id)).statusCode).toBe(409);
  });
});
