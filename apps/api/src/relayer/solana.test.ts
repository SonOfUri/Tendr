// Solana gasless payments through Pimlico's Kora paymaster: the live path against a mocked Kora
// endpoint and a mocked Solana RPC (never the real ones) on test-mode sessions (quotes from the
// 1Click simulator), and the test-mode flow end to end through the routes (no HTTP at all).
import { ed25519 } from '@noble/curves/ed25519';
import type { Merchant } from '@prisma/client';
import { TEST_SOLANA_BLOCKHASH } from '@tendr/contracts';
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
  SOLANA_EXPIRY_CONFIRM_MS,
  SOLANA_RECORDED_PENDING_MS,
  SOLANA_STALE_PENDING_MS,
  SolanaGasless,
  SolanaRpc,
  pollSolanaRelays,
  solanaGasFeeAddress,
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
const PAYER_SECRET = ed25519.utils.randomPrivateKey();
const PAYER = bs58.encode(ed25519.getPublicKey(PAYER_SECRET));
const SIG = (n: number) => bs58.encode(new Uint8Array(64).fill(n));

/** The paymaster's signature over a transaction's message: the transaction id. */
function txIdOf(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  return bs58.encode(ed25519.sign(bytes.subarray(1 + 128), PAYER_SECRET));
}

/** The transaction with the paymaster's signature in slot 1 (what Kora returns). */
function payerSigned(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  Buffer.from(bs58.decode(txIdOf(base64))).copy(bytes, 1);
  return bytes.toString('base64');
}

type Req = { url: string; method: string; params: unknown };

/** A mocked Kora endpoint (Pimlico's Solana paymaster): it signs, never sends. */
class FakeKora {
  calls: Req[] = [];
  blockhash = rand32();
  signError: { code: number; message: string } | null = null;
  signThrows = false;
  /** Returns the transaction with another message (a paymaster that misbehaves). */
  tamper = false;
  onSign: (() => void) | null = null;
  fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    this.calls.push({ url: String(url), method: body.method, params: body.params });
    let result: unknown = null;
    if (body.method === 'getPayerSigner') {
      result = { signer_address: PAYER, payment_address: PAYER };
    } else if (body.method === 'getBlockhash') {
      result = { blockhash: this.blockhash };
    } else if (body.method === 'signTransaction') {
      if (this.signThrows) throw new Error(`socket hang up ${String(url)}`);
      if (this.signError) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { ...this.signError, message: `${this.signError.message} ${KEY}` },
          }),
        );
      }
      this.onSign?.();
      let tx = (body.params as { transaction: string }).transaction;
      if (this.tamper) {
        const b = Buffer.from(tx, 'base64');
        b[b.length - 1]! ^= 1;
        tx = b.toString('base64');
      }
      result = { signed_transaction: payerSigned(tx), signer_pubkey: PAYER };
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
  sent: string[] = [];
  existing = new Set<string>();
  statuses = new Map<string, unknown>();
  txs = new Map<string, unknown>();
  /** Blockhash validity at the finalized root. */
  validBlockhash = true;
  /** Blockhash validity at `processed` (a node ahead of the root). */
  processedValid = true;
  blockhashCommitments: string[] = [];
  /** `sendTransaction`: a JSON-RPC error to answer with, or `throw` (no answer). */
  sendError: { code: number; message: string } | 'throw' | null = null;
  /** A method answered with an unexpected shape. */
  garbage: string | null = null;
  fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    this.calls.push(body.method);
    let result: unknown = null;
    const p = body.params;
    if (body.method === this.garbage) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { value: ['unexpected'] } }),
      );
    }
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
    } else if (body.method === 'sendTransaction') {
      this.sent.push(p[0] as string);
      if (this.sendError === 'throw') throw new Error('connection reset');
      if (this.sendError) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: this.sendError }));
      }
      result = txIdOf(p[0] as string);
    } else if (body.method === 'getSignatureStatuses') {
      result = {
        context: { slot: 1 },
        value: (p[0] as string[]).map((s) => this.statuses.get(s) ?? null),
      };
    } else if (body.method === 'getTransaction') {
      result = this.txs.get(p[0] as string) ?? null;
    } else if (body.method === 'isBlockhashValid') {
      const commitment = (p[1] as { commitment?: string } | undefined)?.commitment;
      this.blockhashCommitments.push(commitment ?? '');
      // A node ahead of the finalized root may already call it invalid at `processed`.
      result = {
        context: { slot: 1 },
        value: commitment === 'finalized' ? this.validBlockhash : this.processedValid,
      };
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
    // The transaction id is the paymaster's signature, known before the broadcast.
    const id = txIdOf(signed);
    expect(res).toEqual({
      submissionId: p.quote.gasSponsorshipId,
      txHash: id,
      status: 'submitted',
    });
    // Kora only signs; Tendr broadcasts the fully signed bytes itself.
    expect(kora.count('signTransaction')).toBe(1);
    expect(kora.calls.find((c) => c.method === 'signTransaction')!.params).toEqual({
      transaction: signed,
    });
    expect(chain.sent).toEqual([payerSigned(signed)]);
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
      txHash: id,
    });
    expect(sp.paymasterData).toEqual({
      kind: 'kora',
      blockhash: kora.blockhash,
      feePayer: PAYER,
      signature: id,
      transaction: payerSigned(signed),
    });
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } });
    expect(quote.depositTxHash).toBe(id);

    // The fee payer is the one prepare recorded with the blockhash: submit does not ask Kora.
    expect(kora.count('getPayerSigner')).toBe(1);
    // A repeat returns the same submission without signing or sending again.
    expect(await submit(p, signed)).toMatchObject({ submissionId: sp.id, status: 'submitted' });
    expect(kora.count('signTransaction')).toBe(1);
    expect(chain.sent).toHaveLength(1);
    // And no new transaction can be prepared for the quote while this one may land.
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({
      code: 'CONFLICT',
      details: { submission_id: sp.id },
    });
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
        expect(kora.count('signTransaction')).toBe(0);
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
      // A price without a limit (the runtime would allow 200 000 CU per instruction).
      const noLimit = await forged(p, {}, { cuLimit: 0, cuPrice: 1_000n });
      expect(await refusal(submit(p, noLimit))).toMatchObject({
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
      expect(kora.count('signTransaction')).toBe(0);
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
    expect(kora.count('signTransaction')).toBe(0);

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
    expect(kora.count('signTransaction')).toBe(0);
  });

  it('live never accepts the test-mode blockhash (ruling T10-f)', async () => {
    kora.blockhash = TEST_SOLANA_BLOCKHASH;
    const p = await koraQuote();
    const { signed } = await preparedAndSigned(p);
    expect(await refusal(submit(p, signed))).toMatchObject({
      code: 'GASLESS_PAYLOAD_MISMATCH',
      details: { field: 'transaction.blockhash' },
    });
    expect(kora.count('signTransaction')).toBe(0);
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
    expect(kora.count('signTransaction')).toBe(0);
  });

  const pollAt = (at: number) =>
    pollSolanaRelays({
      rpc: new SolanaRpc('http://sol.test', chain.fetch),
      livemode: false,
      now: () => new Date(at),
    });

  const rowOf = (id: string) => prisma.gasSponsorship.findUniqueOrThrow({ where: { id } });

  describe('nothing sent: the claim is undone and the shopper may retry', () => {
    it('Kora refuses to sign: GASLESS_SUBMIT_FAILED, and the key is never shown', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      kora.signError = { code: -32000, message: 'Transaction simulation failed: no funds' };
      const err = await refusal(submit(p, signed));
      expect(err).toMatchObject({ code: 'GASLESS_SUBMIT_FAILED', status: 409 });
      expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(KEY);
      const sp = await rowOf(p.quote.gasSponsorshipId!);
      expect(sp).toMatchObject({
        quoteId: null,
        status: 'pending',
        reservationState: 'reserved',
        txHash: null,
      });
      expect(sp.lastError).not.toContain(KEY);
      expect(chain.sent).toEqual([]);
      kora.signError = null;
      expect((await submit(p, signed)).status).toBe('submitted');
      expect(chain.sent).toHaveLength(1);
    });

    it('no answer from Kora: 503 (it only signs, so nothing can have been sent)', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      kora.signThrows = true;
      const err = await refusal(submit(p, signed));
      expect(err).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
      expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(KEY);
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({ quoteId: null });
      expect(chain.sent).toEqual([]);
      kora.signThrows = false;
      expect((await submit(p, signed)).status).toBe('submitted');
    });

    it('Kora returns another transaction: never broadcast', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      kora.tamper = true;
      expect(await refusal(submit(p, signed))).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({ quoteId: null });
      expect(chain.sent).toEqual([]);
    });

    it('the transaction cannot be recorded: never broadcast (I2)', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      const failing = new SolanaGasless(true, {
        kora: new KoraClient({ fetch: kora.fetch }),
        rpc: new SolanaRpc('http://sol.test', chain.fetch),
        now: () => new Date(clock),
        record: () => Promise.reject(new Error('db down')),
      });
      expect(
        await refusal(failing.submit(p.q, { signatures: {}, transaction: signed })),
      ).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(kora.count('signTransaction')).toBe(1);
      expect(chain.sent).toEqual([]);
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({
        quoteId: null,
        status: 'pending',
        txHash: null,
        paymasterData: null,
      });
      expect((await submit(p, signed)).status).toBe('submitted');
    });

    it('preflight refuses the broadcast: GASLESS_SUBMIT_FAILED, the recorded tx is dropped', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      chain.sendError = { code: -32002, message: 'Transaction simulation failed' };
      expect(await refusal(submit(p, signed))).toMatchObject({ code: 'GASLESS_SUBMIT_FAILED' });
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({
        quoteId: null,
        status: 'pending',
        txHash: null,
        paymasterData: null,
      });
      chain.sendError = null;
      expect((await submit(p, signed)).status).toBe('submitted');
    });
  });

  describe('send errors that do not prove nothing was sent (N2)', () => {
    it('"already processed" in preflight: submitted with its id, never undone', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      chain.sendError = {
        code: -32002,
        message: 'Transaction simulation failed: This transaction has already been processed',
      };
      const res = await submit(p, signed);
      expect(res).toMatchObject({ status: 'submitted', txHash: txIdOf(signed) });
      expect(await rowOf(res.submissionId)).toMatchObject({ quoteId: p.quote.id });
    });

    it('a preflight refusal whose signature the chain knows: submitted, never undone', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      chain.statuses.set(txIdOf(signed), { slot: 3, err: null, confirmationStatus: 'processed' });
      chain.sendError = { code: -32002, message: 'Transaction simulation failed: no funds' };
      const res = await submit(p, signed);
      expect(res).toMatchObject({ status: 'submitted', txHash: txIdOf(signed) });
      expect(chain.calls).toContain('getSignatureStatuses');
    });
  });

  it('a claim undone while the submit was signing: never broadcast, re-quote (N3)', async () => {
    const p = await koraQuote();
    const { signed } = await preparedAndSigned(p);
    // The poller's stale-claim undo lands between the claim and the record (Kora signing).
    const signing = kora.fetch;
    const racing = (async (url: string | URL, init?: RequestInit) => {
      const res = await signing(url, init);
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'signTransaction') {
        await prisma.gasSponsorship.update({
          where: { id: p.quote.gasSponsorshipId! },
          data: { quoteId: null, signerAddress: null },
        });
      }
      return res;
    }) as typeof fetch;
    const relayer3 = new SolanaGasless(true, {
      kora: new KoraClient({ fetch: racing }),
      rpc: new SolanaRpc('http://sol.test', chain.fetch),
      now: () => new Date(clock),
    });
    expect(
      await refusal(relayer3.submit(p.q, { signatures: {}, transaction: signed })),
    ).toMatchObject({ code: 'QUOTE_EXPIRED', status: 409 });
    expect(chain.sent).toEqual([]);
    expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({
      quoteId: null,
      txHash: null,
      paymasterData: null,
    });
  });

  it('broadcast outcome unknown: submitted with its known id, re-sent, no second transaction until it cannot land', async () => {
    const p = await koraQuote('shopper');
    const first = await preparedAndSigned(p);
    chain.sendError = 'throw';
    const res = await submit(p, first.signed);
    const id = txIdOf(first.signed);
    expect(res).toMatchObject({ txHash: id, status: 'submitted' });
    expect(await rowOf(res.submissionId)).toMatchObject({ status: 'submitted', txHash: id });
    chain.sendError = null;

    // While it may land: no new transaction can be prepared, and a submit returns this one.
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({ code: 'CONFLICT' });
    expect(await submit(p, first.signed)).toMatchObject({ submissionId: res.submissionId });
    expect(kora.count('signTransaction')).toBe(1);

    // Not seen, blockhash still valid: the same bytes are sent again.
    expect(await pollAt(Date.now())).toBe(0);
    expect(chain.sent).toEqual([payerSigned(first.signed), payerSigned(first.signed)]);
    expect((await rowOf(res.submissionId)).status).toBe('submitted');

    // A node ahead calls the blockhash invalid at `processed`: that never ends it (finalized only).
    chain.processedValid = false;
    expect(await pollAt(Date.now())).toBe(0);
    expect(chain.sent).toHaveLength(3);
    expect(chain.blockhashCommitments.every((c) => c === 'finalized')).toBe(true);

    // Expired at the finalized root and never seen: only a second look a poll interval later fails
    // it (no gas); until then the quote stays locked.
    chain.validBlockhash = false;
    const t0 = Date.now();
    expect(await pollAt(t0)).toBe(0);
    expect((await rowOf(res.submissionId)).status).toBe('submitted');
    expect(await refusal(relayer.prepare(p.q, {}))).toMatchObject({ code: 'CONFLICT' });
    expect(await pollAt(t0 + SOLANA_EXPIRY_CONFIRM_MS - 1000)).toBe(0);
    expect((await rowOf(res.submissionId)).status).toBe('submitted');
    expect(await pollAt(t0 + SOLANA_EXPIRY_CONFIRM_MS)).toBe(1);
    expect(await rowOf(res.submissionId)).toMatchObject({ status: 'failed', sponsor: 'shopper' });
    expect((await rowOf(res.submissionId)).lossRecognizedAt).toBeNull();
    kora.blockhash = rand32();
    chain.validBlockhash = true;
    chain.processedValid = true;
    const second = await preparedAndSigned(p);
    const again = await submit(p, second.signed);
    expect(again.submissionId).not.toBe(res.submissionId);
    expect(again.txHash).toBe(txIdOf(second.signed));
  });

  describe('poller hygiene (I2)', () => {
    it('a claimed row with no recorded transaction is undone once stale; a fresh one waits', async () => {
      const p = await koraQuote();
      await prisma.gasSponsorship.update({
        where: { id: p.quote.gasSponsorshipId! },
        data: { quoteId: p.quote.id, signerAddress: wallet },
      });
      expect(await pollAt(Date.now())).toBe(0);
      expect((await rowOf(p.quote.gasSponsorshipId!)).quoteId).toBe(p.quote.id);
      expect(await pollAt(Date.now() + SOLANA_STALE_PENDING_MS + 1000)).toBe(1);
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({
        quoteId: null,
        status: 'pending',
        reservationState: 'reserved',
      });
      // Nothing was asked of the chain for it.
      expect(chain.calls).not.toContain('getSignatureStatuses');
    });

    it('a row recorded but never marked submitted (crash) is picked up by its id', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      await submit(p, signed);
      const id = txIdOf(signed);
      // As if the process stopped right after recording the transaction.
      await prisma.gasSponsorship.update({
        where: { id: p.quote.gasSponsorshipId! },
        data: { status: 'pending' },
      });
      await prisma.quote.update({ where: { id: p.quote.id }, data: { depositTxHash: null } });
      // Within the age gate it may be a submit still sending: left alone.
      await pollAt(Date.now() + SOLANA_RECORDED_PENDING_MS - 5_000);
      expect((await rowOf(p.quote.gasSponsorshipId!)).status).toBe('pending');
      await pollAt(Date.now() + SOLANA_RECORDED_PENDING_MS + 1_000);
      expect(await rowOf(p.quote.gasSponsorshipId!)).toMatchObject({
        status: 'submitted',
        txHash: id,
      });
      expect(
        (await prisma.quote.findUniqueOrThrow({ where: { id: p.quote.id } })).depositTxHash,
      ).toBe(id);
    });

    it('a row whose lookup fails is marked checked, so it cannot starve the others', async () => {
      const p = await koraQuote();
      const { signed } = await preparedAndSigned(p);
      await submit(p, signed);
      chain.garbage = 'getSignatureStatuses';
      const at = Date.now() + 5_000;
      expect(await pollAt(at)).toBe(0);
      expect((await rowOf(p.quote.gasSponsorshipId!)).updatedAt.getTime()).toBe(at);
    });
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
          signatures: [SIG(1), SIG(2)],
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
      const id = txIdOf(signed);
      // Not yet seen: waits (and sends the same bytes again).
      expect(await poll()).toBe(0);
      expect(chain.sent).toHaveLength(2);
      chain.statuses.set(id, {
        slot: 10,
        confirmations: null,
        err: null,
        confirmationStatus: 'confirmed',
      });
      chain.txs.set(id, landed({}));
      expect(await poll()).toBe(1);
      const sp = await prisma.gasSponsorship.findUniqueOrThrow({
        where: { id: p.quote.gasSponsorshipId! },
      });
      // 2 054 280 lamports × $150 / 1e9 = $0.308142.
      expect(sp).toMatchObject({
        status: 'confirmed',
        txHash: id,
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
      const id = res.txHash!;
      const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
      const owner = await feeOwner();
      chain.statuses.set(id, {
        slot: 10,
        confirmations: 5,
        err: null,
        confirmationStatus: 'finalized',
      });
      chain.txs.set(
        id,
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
      const id = res.txHash!;
      const fee = BigInt(p.quote.networkFeeAmount!.toFixed(0));
      chain.statuses.set(id, { slot: 10, err: null, confirmationStatus: 'confirmed' });
      const owner = await feeOwner();
      chain.txs.set(
        id,
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
      const id = res.txHash!;
      chain.statuses.set(id, {
        slot: 10,
        err: { InstructionError: [3, 'Custom'] },
        confirmationStatus: 'confirmed',
      });
      chain.txs.set(id, landed({ err: { InstructionError: [3, 'Custom'] } }));
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
      const t0 = Date.now();
      expect(await pollAt(t0)).toBe(0);
      // The second look, a poll interval later, fails it.
      expect(await pollAt(t0 + SOLANA_EXPIRY_CONFIRM_MS)).toBe(1);
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
      // Ruling T10-g: the chain's gas-fee account, in its own address form.
      expect(opts.json().fee_recipient).toBe(await solanaGasFeeAddress());
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
      const prep = await call('POST', 'gasless/prepare', s.client_secret, { quote_id: quote.id });
      // Test mode signs only a blockhash no cluster ever produced (ruling T10-f).
      expect(prep.json().to_sign[0].typed_data.blockhash).toBe(TEST_SOLANA_BLOCKHASH);
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
          blockhash: prep.json().to_sign[0].typed_data.blockhash as string,
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
