// Solana gasless payments through Pimlico's Kora paymaster: the live path against a mocked Kora
// endpoint and a mocked Solana RPC (never the real ones) on test-mode sessions (quotes from the
// 1Click simulator), and the test-mode flow end to end through the routes (no HTTP at all).
import { ed25519 } from '@noble/curves/ed25519';
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
import { getKeyVault } from '../keyvault/index.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { clearSecretCache, putSecret } from '../secrets/secrets.js';
import { createApiKey, createMerchant, createRow, resetDb } from '../test/helpers.js';
import { isolatedSimStore } from '../test/sim-1click.js';
import { gaslessQuote, resetRelayers } from './index.js';
import {
  KoraClient,
  SIMULATED_KORA_PAYER,
  SOLANA_BLOCKHASH_MAX_AGE_MS,
  SolanaGasless,
  SolanaRpc,
  pollSolanaRelays,
} from './solana.js';
import {
  associatedTokenAccount,
  buildPaymentTransaction,
  SOLANA_GASLESS_TOKENS,
  type SolanaPayment,
} from './solana-tx.js';

const sim1click = isolatedSimStore();
const USDC = 'nep141:usdc.test'; // settlement asset (NEAR)
const USDC_SOL = SOLANA_GASLESS_TOKENS[0]!.assetId;
const MINT = SOLANA_GASLESS_TOKENS[0]!.mint;
const SOL = 'nep141:sol.omft.near';
const KEY = 'pim_SOLSECRETKEY987';
const rand32 = () => bs58.encode(ed25519.utils.randomPrivateKey());
const PAYER = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const SIG = (n: number) => bs58.encode(new Uint8Array(64).fill(n));

type Req = { url: string; method: string; params: unknown };

/** A mocked Kora endpoint (Pimlico's Solana paymaster). */
class FakeKora {
  calls: Req[] = [];
  blockhash = rand32();
  sendError: { code: number; message: string } | null = null;
  sendHttp: number | null = null;
  sendThrows = false;
  fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    this.calls.push({ url: String(url), method: body.method, params: body.params });
    let result: unknown = null;
    if (body.method === 'getPayerSigner') {
      result = { signer_address: PAYER, payment_address: PAYER };
    } else if (body.method === 'getBlockhash') {
      result = { blockhash: this.blockhash };
    } else if (body.method === 'signAndSendTransaction') {
      if (this.sendThrows) throw new Error(`socket hang up ${String(url)}`);
      if (this.sendHttp) return new Response('bad gateway', { status: this.sendHttp });
      if (this.sendError) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { ...this.sendError, message: `${this.sendError.message} ${KEY}` },
          }),
        );
      }
      const tx = (body.params as { transaction: string }).transaction;
      result = { signature: SIG(7), signed_transaction: tx, signer_pubkey: PAYER };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  }) as typeof fetch;
  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
}

/** A mocked Solana JSON-RPC node. */
class FakeSolana {
  calls: string[] = [];
  existing = new Set<string>();
  statuses = new Map<string, unknown>();
  txs = new Map<string, unknown>();
  validBlockhash = true;
  addressSignatures: string[] = [];
  fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    this.calls.push(body.method);
    let result: unknown = null;
    const p = body.params;
    if (body.method === 'getMultipleAccounts') {
      result = {
        context: { slot: 1 },
        value: (p[0] as string[]).map((a) =>
          this.existing.has(a)
            ? {
                lamports: 2039280,
                owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                data: ['', 'base64'],
                executable: false,
                rentEpoch: 0,
              }
            : null,
        ),
      };
    } else if (body.method === 'getSignatureStatuses') {
      result = {
        context: { slot: 1 },
        value: (p[0] as string[]).map((s) => this.statuses.get(s) ?? null),
      };
    } else if (body.method === 'getTransaction') {
      result = this.txs.get(p[0] as string) ?? null;
    } else if (body.method === 'isBlockhashValid') {
      result = { context: { slot: 1 }, value: this.validBlockhash };
    } else if (body.method === 'getSignaturesForAddress') {
      result = this.addressSignatures.map((signature) => ({ signature, err: null, slot: 1 }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  }) as typeof fetch;
}

/** Puts the shopper's signature into a prepared transaction (signature slot 2 of 2). */
function signTx(base64: string, secret: Uint8Array): string {
  const bytes = Buffer.from(base64, 'base64');
  expect(bytes[0]).toBe(2);
  const message = bytes.subarray(1 + 128);
  const sig = ed25519.sign(message, secret);
  Buffer.from(sig).copy(bytes, 1 + 64);
  return bytes.toString('base64');
}

describe('Solana gasless payments (Kora)', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let sim: SimulatedOneClick;
  let secret: Uint8Array;
  let wallet: string;
  let kora: FakeKora;
  let chain: FakeSolana;
  let relayer: SolanaGasless;
  let logs: string[];
  let clock: number;

  beforeEach(async () => {
    await resetDb();
    await sim1click.clear();
    resetTokenCache();
    resetRelayers();
    clearSecretCache();
    resetNearClients();
    fakeNearClient(false);
    sim = new SimulatedOneClick({ store: sim1click.store() });
    resetOneClickProviders({ simulated: sim });
    registerWatcherHooks();
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
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
    wallet = bs58.encode(ed25519.getPublicKey(secret));
    await putSecret(KEY, 'pimlico');
    kora = new FakeKora();
    chain = new FakeSolana();
    clock = Date.now();
    relayer = new SolanaGasless(true, {
      kora: new KoraClient({ fetch: kora.fetch }),
      rpc: new SolanaRpc('http://sol.test', chain.fetch),
      priorityFee: async () => 5_000n,
      now: () => new Date(clock),
    });
  });
  afterEach(async () => {
    // The API key never reaches a log line.
    expect(logs.join('\n')).not.toContain(KEY);
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

  /** A `kora` quote for the wallet; the merchant sponsors unless `shopper`. */
  async function koraQuote(gasPayer?: 'shopper') {
    const s = await newSession(gasPayer);
    const qr = await call('POST', 'quote', s.client_secret, {
      origin_asset: USDC_SOL,
      wallet_address: wallet,
      gasless_method: 'kora',
    });
    expect(qr.statusCode, qr.body).toBe(201);
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: qr.json().id } });
    const scope = { merchantId: merchant.id, livemode: false };
    const ctx = { ...scope, db: scopedDb(scope), sessionId: s.id };
    const { q } = await gaslessQuote(ctx, quote.id);
    return { s, ctx, quote, q };
  }

  const feeOwner = async () => bs58.encode((await getKeyVault().publicKey('gas-fees-solana')).raw);

  async function payment(
    p: Awaited<ReturnType<typeof koraQuote>>,
    over: Partial<SolanaPayment> = {},
  ): Promise<SolanaPayment> {
    const shopper = p.quote.networkFeePaidBy === 'buyer';
    return {
      feePayer: PAYER,
      wallet,
      mint: MINT,
      decimals: 6,
      depositAddress: p.quote.depositAddress,
      amount: BigInt(p.quote.amountIn.toFixed(0)),
      feeOwner: shopper ? await feeOwner() : null,
      fee: shopper ? BigInt(p.quote.networkFeeAmount!.toFixed(0)) : 0n,
      ...over,
    };
  }

  /** Prepares through the live relayer and signs what it returned. */
  async function preparedAndSigned(p: Awaited<ReturnType<typeof koraQuote>>) {
    const prepared = await relayer.prepare(p.q, {});
    const td = prepared.to_sign[0]!.typed_data as { transaction: string };
    return { prepared, signed: signTx(td.transaction, secret) };
  }

  /** A transaction built by hand with Kora's blockhash (issued through prepare) and signed. */
  async function forged(
    p: Awaited<ReturnType<typeof koraQuote>>,
    over: Partial<SolanaPayment>,
    budget: { cuLimit?: number; cuPrice?: bigint } = {},
  ) {
    await relayer.prepare(p.q, {});
    const built = await buildPaymentTransaction(await payment(p, over), {
      blockhash: kora.blockhash,
      createDeposit: true,
      createFee: false,
      cuLimit: budget.cuLimit ?? 100_000,
      cuPrice: budget.cuPrice ?? 5_000n,
    });
    return signTx(built.transaction, secret);
  }

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (err) {
      if (err instanceof AppError) return err;
      throw err;
    }
    throw new Error('expected a refusal');
  }

  const submit = (p: Awaited<ReturnType<typeof koraQuote>>, transaction: string) =>
    relayer.submit(p.q, { signatures: {}, transaction });

  it('prepares a transaction paid by the Kora paymaster and relays it once', async () => {
    const p = await koraQuote();
    expect(p.quote.networkFeePaidBy).toBe('merchant');
    const { prepared, signed } = await preparedAndSigned(p);
    const depositAta = await associatedTokenAccount(p.quote.depositAddress, MINT);
    expect(prepared).toMatchObject({
      quote_id: p.quote.id,
      method: 'kora',
      chain: 'sol',
      chain_id: null,
      signer: wallet,
      amount: p.quote.amountIn.toFixed(0),
      fee_amount: '0',
    });
    expect(prepared.to_sign).toHaveLength(1);
    expect(prepared.to_sign[0]!.kind).toBe('solana_transaction');
    expect(prepared.to_sign[0]!.typed_data).toMatchObject({
      fee_payer: PAYER,
      blockhash: kora.blockhash,
      transfers: [
        {
          leg: 'payment',
          mint: MINT,
          to: p.quote.depositAddress,
          token_account: depositAta,
          amount: p.quote.amountIn.toFixed(0),
        },
      ],
    });
    // The deposit address's token account did not exist: created, paid by the paymaster.
    expect(chain.calls).toEqual(['getMultipleAccounts']);

    const res = await submit(p, signed);
    expect(res).toEqual({
      submissionId: p.quote.gasSponsorshipId,
      txHash: SIG(7),
      status: 'submitted',
    });
    expect(kora.count('signAndSendTransaction')).toBe(1);
    const sent = kora.calls.find((c) => c.method === 'signAndSendTransaction')!;
    expect(sent.params).toEqual({ transaction: signed });
    for (const c of kora.calls) {
      expect(c.url).toBe(`https://solana.pimlico.io/v1/mainnet/rpc?apikey=${KEY}`);
    }
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: p.quote.gasSponsorshipId! },
    });
    expect(sp).toMatchObject({
      quoteId: p.quote.id,
      method: 'kora',
      provider: 'pimlico',
      sponsor: 'merchant',
      status: 'submitted',
      reservationState: 'reserved',
      // Base58 is case-sensitive: kept as is.
      signerAddress: wallet,
      txHash: SIG(7),
    });
    expect(sp.paymasterData).toMatchObject({
      kind: 'kora',
      blockhash: kora.blockhash,
      feePayer: PAYER,
    });
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } });
    expect(quote.depositTxHash).toBe(SIG(7));

    // A repeat returns the same submission without calling Kora again.
    expect(await submit(p, signed)).toMatchObject({ submissionId: sp.id, status: 'submitted' });
    expect(kora.count('signAndSendTransaction')).toBe(1);
  });

  it('skips the account creation when the deposit token account exists', async () => {
    const p = await koraQuote();
    chain.existing.add(await associatedTokenAccount(p.quote.depositAddress, MINT));
    const { prepared, signed } = await preparedAndSigned(p);
    const tx = Buffer.from(
      (prepared.to_sign[0]!.typed_data as { transaction: string }).transaction,
      'base64',
    );
    // No Associated Token program in the message.
    const ataProgram = Buffer.from(bs58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
    expect(tx.includes(ataProgram)).toBe(false);
    expect((await submit(p, signed)).status).toBe('submitted');
  });

  it('the shopper pays: a second transfer of the fee to the gas-fees-solana account', async () => {
    const p = await koraQuote('shopper');
    expect(p.quote.networkFeePaidBy).toBe('buyer');
    const fee = p.quote.networkFeeAmount!.toFixed(0);
    const owner = await feeOwner();
    const { prepared, signed } = await preparedAndSigned(p);
    expect(prepared.fee_amount).toBe(fee);
    expect((prepared.to_sign[0]!.typed_data as { transfers: unknown[] }).transfers).toEqual([
      expect.objectContaining({ leg: 'payment', amount: p.quote.amountIn.toFixed(0) }),
      {
        leg: 'fee',
        mint: MINT,
        to: owner,
        token_account: await associatedTokenAccount(owner, MINT),
        amount: fee,
      },
    ]);
    const res = await submit(p, signed);
    expect(res.status).toBe('submitted');
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: res.submissionId } });
    expect(sp).toMatchObject({
      sponsor: 'shopper',
      method: 'kora',
      provider: 'pimlico',
      feeMode: 'token',
      feeAsset: USDC_SOL,
      status: 'submitted',
    });
    expect(sp.feeAmount!.toFixed()).toBe(fee);

    // A sponsored-shaped transaction (no fee leg) is refused for a shopper-paid quote.
    const p2 = await koraQuote('shopper');
    const noFee = await forged(p2, { feeOwner: null, fee: 0n });
    expect(await refusal(submit(p2, noFee))).toMatchObject({
      code: 'GASLESS_PAYLOAD_MISMATCH',
      details: { field: 'transaction.fee' },
    });
  });

  describe('refuses anything but the quoted payment, before calling Pimlico', () => {
    const attacker = () => bs58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
    const cases: [string, Partial<SolanaPayment> | 'fee-payer-signed', string][] = [
      [
        'an extra instruction (a second transfer)',
        { feeOwner: 'ATTACKER', fee: 1n },
        'transaction.instructions[4]',
      ],
      ['a changed amount', { amount: -1n }, 'transaction.payment.amount'],
      ['another destination', { depositAddress: 'ATTACKER' }, 'transaction.instructions[2]'],
      ['another fee payer', { feePayer: 'ATTACKER' }, 'transaction.fee_payer'],
      [
        'another mint',
        { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
        'transaction.instructions[2]',
      ],
      [
        'a fee payer signature already present',
        'fee-payer-signed',
        'transaction.fee_payer_signature',
      ],
    ];
    for (const [name, over, field] of cases) {
      it(name, async () => {
        const p = await koraQuote();
        let tx: string;
        if (over === 'fee-payer-signed') {
          const { signed } = await preparedAndSigned(p);
          const b = Buffer.from(signed, 'base64');
          b[1] = 1;
          tx = b.toString('base64');
        } else {
          const o = { ...over };
          if (o.feeOwner === 'ATTACKER') o.feeOwner = attacker();
          if (o.depositAddress === 'ATTACKER') o.depositAddress = attacker();
          if (o.feePayer === 'ATTACKER') o.feePayer = attacker();
          if (o.amount === -1n) o.amount = BigInt(p.quote.amountIn.toFixed(0)) - 1n;
          tx = await forged(p, o);
        }
        expect(await refusal(submit(p, tx))).toMatchObject({
          code: 'GASLESS_PAYLOAD_MISMATCH',
          status: 409,
          details: { field },
        });
        expect(kora.count('signAndSendTransaction')).toBe(0);
        const sp = await prisma.gasSponsorship.findUniqueOrThrow({
          where: { id: p.quote.gasSponsorshipId! },
        });
        expect(sp.quoteId).toBeNull();
        // Refused transactions do not count against the wallet's limit.
        const key = `tendr:gasless:submit:addr:${wallet.toLowerCase()}:${Math.floor(Date.now() / 3_600_000)}`;
        expect(await getRedis().get(key)).toBeNull();
      });
    }

    it('a compute budget above the bounds (Tendr pays the priority fee)', async () => {
      const p = await koraQuote();
      const price = await forged(p, {}, { cuPrice: 1_000_001n });
      expect(await refusal(submit(p, price))).toMatchObject({
        details: { field: 'transaction.compute_unit_price' },
      });
      const limit = await forged(p, {}, { cuLimit: 200_001 });
      expect(await refusal(submit(p, limit))).toMatchObject({
        details: { field: 'transaction.compute_unit_limit' },
      });
      // At the bounds: accepted.
      const ok = await forged(p, {}, { cuLimit: 200_000, cuPrice: 1_000_000n });
      expect((await submit(p, ok)).status).toBe('submitted');
    });

    it('a signature by another key, or none', async () => {
      const p = await koraQuote();
      const { prepared } = await preparedAndSigned(p);
      const unsigned = (prepared.to_sign[0]!.typed_data as { transaction: string }).transaction;
      expect(await refusal(submit(p, unsigned))).toMatchObject({
        details: { field: 'transaction.signature' },
      });
      const other = signTx(unsigned, ed25519.utils.randomPrivateKey());
      expect(await refusal(submit(p, other))).toMatchObject({
        details: { field: 'transaction.signature' },
      });
      // EVM-style signatures instead of a transaction.
      expect(
        await refusal(
          relayer.submit(p.q, {
            signatures: { payment: { message: {}, signature: '0x00' } },
          }),
        ),
      ).toMatchObject({ details: { field: 'transaction' } });
      expect(kora.count('signAndSendTransaction')).toBe(0);
    });
  });

  it('a blockhash older than 60 s, or not issued for this quote, is GASLESS_EXPIRED', async () => {
    const p = await koraQuote();
    const { signed } = await preparedAndSigned(p);
    clock += SOLANA_BLOCKHASH_MAX_AGE_MS + 1;
    expect(await refusal(submit(p, signed))).toMatchObject({
      code: 'GASLESS_EXPIRED',
      status: 409,
    });
    expect(kora.count('signAndSendTransaction')).toBe(0);

    // A blockhash Tendr never issued for this quote.
    clock = Date.now();
    const p2 = await koraQuote();
    const built = await buildPaymentTransaction(await payment(p2), {
      blockhash: rand32(),
      createDeposit: true,
      createFee: false,
      cuLimit: 100_000,
      cuPrice: 0n,
    });
    expect(await refusal(submit(p2, signTx(built.transaction, secret)))).toMatchObject({
      code: 'GASLESS_EXPIRED',
    });
    expect(kora.count('signAndSendTransaction')).toBe(0);
  });

  it('native SOL is never routed here, and unlisted tokens get no kora quote', async () => {
    const s = await newSession();
    const opts = await call('POST', 'gasless/options', s.client_secret, {
      origin_asset: SOL,
      wallet_address: wallet,
    });
    expect(opts.statusCode, opts.body).toBe(200);
    expect(opts.json()).toMatchObject({
      chain: 'sol',
      family: 'solana',
      native_symbol: 'SOL',
      options: [],
    });
    const quote = await call('POST', 'quote', s.client_secret, {
      origin_asset: SOL,
      wallet_address: wallet,
      gasless_method: 'kora',
    });
    expect(quote.statusCode, quote.body).toBe(400);
    expect(quote.json().error.details).toMatchObject({ field: 'gasless_method' });
    expect(kora.calls).toEqual([]);
  });

  it('a released sponsorship is refused; the daily loss cap stops both modes', async () => {
    const p = await koraQuote();
    const { signed } = await preparedAndSigned(p);
    await prisma.gasSponsorship.update({
      where: { id: p.quote.gasSponsorshipId! },
      data: { reservationState: 'released' },
    });
    expect(await refusal(submit(p, signed))).toMatchObject({ code: 'SPONSORSHIP_RELEASED' });

    const sponsored = await koraQuote();
    const paying = await koraQuote('shopper');
    const a = await preparedAndSigned(sponsored);
    const b = await preparedAndSigned(paying);
    await prisma.gasSponsorship.create({
      data: {
        id: newId('gas'),
        merchantId: merchant.id,
        livemode: false,
        sessionId: sponsored.s.id,
        chain: 'sol',
        method: 'kora',
        provider: 'pimlico',
        sponsor: 'tendr',
        status: 'failed',
        costUsd: '1000',
        lossRecognizedAt: new Date(),
      },
    });
    for (const [x, signed2] of [
      [sponsored, a.signed],
      [paying, b.signed],
    ] as const) {
      expect(await refusal(relayer.prepare(x.q, {}))).toMatchObject({
        code: 'GASLESS_NOT_AVAILABLE',
      });
      expect(await refusal(submit(x, signed2))).toMatchObject({ code: 'GASLESS_NOT_AVAILABLE' });
    }
    expect(kora.count('signAndSendTransaction')).toBe(0);
  });

  it('Kora refuses: GASLESS_SUBMIT_FAILED, the claim is undone, and the key is never shown', async () => {
    const p = await koraQuote();
    const { signed } = await preparedAndSigned(p);
    kora.sendError = { code: -32000, message: 'Transaction simulation failed: insufficient funds' };
    const err = await refusal(submit(p, signed));
    expect(err).toMatchObject({ code: 'GASLESS_SUBMIT_FAILED', status: 409 });
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(KEY);
    const sp = await prisma.gasSponsorship.findUniqueOrThrow({
      where: { id: p.quote.gasSponsorshipId! },
    });
    expect(sp).toMatchObject({ quoteId: null, status: 'pending', reservationState: 'reserved' });
    expect(sp.lastError).not.toContain(KEY);
    // Retry relays.
    kora.sendError = null;
    expect((await submit(p, signed)).status).toBe('submitted');
  });

  it('no answer from Kora: 503, the submission stays pending and is reconciled on chain', async () => {
    const p = await koraQuote();
    const { signed } = await preparedAndSigned(p);
    kora.sendThrows = true;
    const err = await refusal(submit(p, signed));
    expect(err).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(KEY);
    const id = p.quote.gasSponsorshipId!;
    expect(await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } })).toMatchObject({
      quoteId: p.quote.id,
      status: 'pending',
      txHash: null,
    });
    // A retry returns the pending submission: never a second payment.
    kora.sendThrows = false;
    expect(await submit(p, signed)).toEqual({ submissionId: id, status: 'pending' });
    expect(kora.count('signAndSendTransaction')).toBe(1);

    const poll = (at: number) =>
      pollSolanaRelays({
        rpc: new SolanaRpc('http://sol.test', chain.fetch),
        livemode: false,
        now: () => new Date(at),
      });
    // Blockhash still valid: wait.
    expect(await poll(Date.now() + 120_000)).toBe(0);
    expect((await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } })).status).toBe(
      'pending',
    );
    // Expired: the shopper's signed transaction is found on chain → submitted with its signature.
    chain.validBlockhash = false;
    const shopperSig = bs58.encode(Buffer.from(signed, 'base64').subarray(65, 129));
    chain.addressSignatures = [SIG(3), SIG(9)];
    chain.txs.set(SIG(3), { transaction: { signatures: [SIG(3), SIG(4)] }, meta: null });
    chain.txs.set(SIG(9), { transaction: { signatures: [SIG(9), shopperSig] }, meta: null });
    await poll(Date.now() + 120_000);
    expect(await prisma.gasSponsorship.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'submitted',
      txHash: SIG(9),
    });
    expect(
      (await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } })).depositTxHash,
    ).toBe(SIG(9));
  });

  it('no answer from Kora and never landed: the claim is undone once the blockhash expired', async () => {
    const p = await koraQuote();
    const { signed } = await preparedAndSigned(p);
    kora.sendThrows = true;
    await refusal(submit(p, signed));
    chain.validBlockhash = false;
    chain.addressSignatures = [];
    await pollSolanaRelays({
      rpc: new SolanaRpc('http://sol.test', chain.fetch),
      livemode: false,
      now: () => new Date(Date.now() + 120_000),
    });
    expect(
      await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: p.quote.gasSponsorshipId! } }),
    ).toMatchObject({ quoteId: null, status: 'pending', reservationState: 'reserved' });
  });

  describe('outcomes (SOLANA_RPC_URL)', () => {
    const poll = () =>
      pollSolanaRelays({ rpc: new SolanaRpc('http://sol.test', chain.fetch), livemode: false });

    function landed(opts: {
      err?: unknown;
      feeAccountIndex?: number;
      feeBefore?: string;
      feeAfter?: string;
      owner?: string;
      /** The gas-fee token account, at index 4 of the account keys. */
      feeAccount?: string;
    }) {
      return {
        slot: 10,
        transaction: {
          signatures: [SIG(7), SIG(8)],
          message: {
            accountKeys: [PAYER, wallet, rand32(), rand32(), opts.feeAccount ?? rand32()],
          },
        },
        meta: {
          err: opts.err ?? null,
          fee: 15_000,
          // Fee + the deposit account's rent, paid by the paymaster.
          preBalances: [1_000_000_000, 0],
          postBalances: [1_000_000_000 - 15_000 - 2_039_280, 0],
          computeUnitsConsumed: 45_000,
          preTokenBalances:
            opts.feeBefore !== undefined
              ? [
                  {
                    accountIndex: opts.feeAccountIndex ?? 4,
                    mint: MINT,
                    owner: opts.owner,
                    uiTokenAmount: { amount: opts.feeBefore, decimals: 6 },
                  },
                ]
              : [],
          postTokenBalances:
            opts.feeAfter !== undefined
              ? [
                  {
                    accountIndex: opts.feeAccountIndex ?? 4,
                    mint: MINT,
                    owner: opts.owner,
                    uiTokenAmount: { amount: opts.feeAfter, decimals: 6 },
                  },
                ]
              : [],
        },
      };
    }

    it('sponsored: confirmed with the actual SOL cost; settled only at collection', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      await submit(p, signed);
      // Not yet seen: waits.
      expect(await poll()).toBe(0);
      chain.statuses.set(SIG(7), {
        slot: 10,
        confirmations: null,
        err: null,
        confirmationStatus: 'confirmed',
      });
      chain.txs.set(SIG(7), landed({}));
      expect(await poll()).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: p.quote.gasSponsorshipId! },
      });
      // 2 054 280 lamports × $150 / 1e9 = $0.308142.
      expect(sp).toMatchObject({
        status: 'confirmed',
        txHash: SIG(7),
        reservationState: 'reserved',
      });
      expect(sp.costUsd!.toFixed()).toBe('0.308142');
      expect(sp.gasUsed!.toFixed()).toBe('45000');
      // Above the merchant's estimate: the rest is recorded as unrecovered (daily loss cap).
      expect(sp.unrecoveredUsd!.gt(0)).toBe(true);
      expect(sp.unrecoveredUsd!.toFixed()).toBe(sp.costUsd!.minus(sp.estimateUsd!).toFixed());
      expect(await poll()).toBe(0);
    });

    it('shopper pays: fee revenue from the gas-fee account balance change, capped', async () => {
      const p = await koraQuote('shopper');
      const { signed } = await preparedAndSigned(p);
      const res = await submit(p, signed);
      const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
      const owner = await feeOwner();
      chain.statuses.set(SIG(7), {
        slot: 10,
        confirmations: 5,
        err: null,
        confirmationStatus: 'finalized',
      });
      chain.txs.set(
        SIG(7),
        landed({
          feeBefore: '100',
          feeAfter: (100n + fee + 5n).toString(),
          owner,
          feeAccount: await associatedTokenAccount(owner, MINT),
        }),
      );
      expect(await poll()).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: res.submissionId } });
      expect(sp.status).toBe('confirmed');
      // Never more than the fee signed.
      expect(sp.feeCollected!.toFixed()).toBe(fee.toString());
    });

    it('shopper pays, account created in the tx: no pre-balance counts as 0', async () => {
      const p = await koraQuote('shopper');
      const { signed } = await preparedAndSigned(p);
      const res = await submit(p, signed);
      const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
      chain.statuses.set(SIG(7), { slot: 10, err: null, confirmationStatus: 'confirmed' });
      const owner = await feeOwner();
      chain.txs.set(
        SIG(7),
        landed({
          feeAfter: fee.toString(),
          owner,
          feeAccount: await associatedTokenAccount(owner, MINT),
        }),
      );
      await poll();
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: res.submissionId } });
      expect(sp.feeCollected!.toFixed()).toBe(fee.toString());
    });

    it('a transaction that failed on chain: failed with its cost; a shopper relay is a loss', async () => {
      const p = await koraQuote('shopper');
      const { signed } = await preparedAndSigned(p);
      const res = await submit(p, signed);
      chain.statuses.set(SIG(7), {
        slot: 10,
        err: { InstructionError: [3, 'Custom'] },
        confirmationStatus: 'confirmed',
      });
      chain.txs.set(SIG(7), landed({ err: { InstructionError: [3, 'Custom'] } }));
      expect(await poll()).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: res.submissionId } });
      expect(sp).toMatchObject({ status: 'failed', sponsor: 'tendr' });
      expect(sp.lossRecognizedAt).not.toBeNull();
    });

    it('never landed and the blockhash expired: failed, no gas, the hold is kept', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      await submit(p, signed);
      chain.validBlockhash = false;
      expect(await poll()).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: p.quote.gasSponsorshipId! },
      });
      expect(sp).toMatchObject({
        status: 'failed',
        sponsor: 'merchant',
        reservationState: 'reserved',
      });
      expect(sp.lossRecognizedAt).toBeNull();
    });
  });

  describe('test mode (simulated: no Pimlico, no RPC)', () => {
    it('options → quote → prepare → sign → submit → paid on detection → settled', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const s = await newSession();
      const opts = await call('POST', 'gasless/options', s.client_secret, {
        origin_asset: USDC_SOL,
        wallet_address: wallet,
      });
      expect(opts.statusCode, opts.body).toBe(200);
      expect(opts.json().options).toEqual([
        { method: 'kora', paid_by: 'merchant', reason: null, fee_modes: [], token_fee: null },
      ]);
      const qr = await call('POST', 'quote', s.client_secret, {
        origin_asset: USDC_SOL,
        wallet_address: wallet,
        gasless_method: 'kora',
      });
      expect(qr.statusCode, qr.body).toBe(201);
      const quote = qr.json();
      const prep = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id });
      expect(prep.statusCode, prep.body).toBe(200);
      const td = prep.json().to_sign[0].typed_data;
      expect(td.fee_payer).toBe(SIMULATED_KORA_PAYER);
      const sub = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        transaction: signTx(td.transaction, secret),
      });
      expect(sub.statusCode, sub.body).toBe(202);
      expect(sub.json().status).toBe('confirmed');
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: sub.json().submission_id },
      });
      expect(sp).toMatchObject({
        method: 'kora',
        provider: 'pimlico',
        status: 'confirmed',
        reservationState: 'reserved',
      });
      expect(await prisma.payment.count()).toBe(0);
      await pollDeposit(quote.deposit_address, { livemode: false });
      const pay = await prisma.payment.findFirstOrThrow({ where: { quoteId: quote.id } });
      expect(pay.status).toBe('SETTLED');
      expect(await prisma.gasSponsorship.findUniqueOrThrow({ where: { id: sp.id } })).toMatchObject(
        {
          reservationState: 'settled',
          recoveredFromPaymentId: pay.id,
        },
      );
      // Nothing went over HTTP.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a tampered transaction is refused in test mode', async () => {
      const s = await newSession();
      const qr = await call('POST', 'quote', s.client_secret, {
        origin_asset: USDC_SOL,
        wallet_address: wallet,
        gasless_method: 'kora',
      });
      const quote = qr.json();
      await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id });
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
      const built = await buildPaymentTransaction(
        {
          feePayer: SIMULATED_KORA_PAYER,
          wallet,
          mint: MINT,
          decimals: 6,
          depositAddress: row.depositAddress,
          amount: BigInt(row.amountIn.toFixed(0)) + 1n,
          feeOwner: null,
          fee: 0n,
        },
        {
          blockhash: rand32(),
          createDeposit: true,
          createFee: false,
          cuLimit: 100_000,
          cuPrice: 0n,
        },
      );
      const sub = await call('POST', 'gasless/submit', s.client_secret, {
        quote_id: quote.id,
        transaction: signTx(built.transaction, secret),
      });
      expect(sub.statusCode, sub.body).toBe(409);
      expect(sub.json().error).toMatchObject({
        code: 'GASLESS_PAYLOAD_MISMATCH',
        details: { field: 'transaction.payment.amount' },
      });
    });
  });
});
