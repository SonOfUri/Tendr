// The two HTTP clients of Solana gasless payments (project 5a): Kora on Pimlico (the paymaster
// signs as fee payer; it never broadcasts for us) and the Solana JSON-RPC at SOLANA_RPC_URL (Tendr
// broadcasts the fully signed transaction, re-sends it, and reads its outcome).
import bs58 from 'bs58';
import { z } from 'zod';
import { env } from '../env.js';
import { pimlicoApiKey } from './evm/pimlico.js';
import { isSolanaAddress } from './solana-tx.js';

/**
 * A Kora call failed; the message never contains the API key. `refused`: Kora answered with a
 * JSON-RPC error. `unavailable`: no usable answer. Kora only signs (`signTransaction`), so no
 * failure can have sent anything.
 */
export class KoraError extends Error {
  constructor(
    message: string,
    readonly kind: 'refused' | 'unavailable',
  ) {
    super(message);
    this.name = 'KoraError';
  }
}

function redact(s: string, key: string): string {
  if (!key) return s;
  let out = s;
  for (const form of new Set([key, encodeURIComponent(key)])) {
    out = out.split(form).join('[redacted]');
  }
  return out;
}

/** Kora's JSON-RPC on Pimlico: `https://solana.pimlico.io/v1/{network}/rpc?apikey=…`. */
export class KoraClient {
  constructor(
    private readonly deps: {
      fetch?: typeof fetch;
      apiKey?: () => Promise<string>;
      network?: () => 'mainnet' | 'devnet';
      timeoutMs?: number;
    } = {},
  ) {}

  private async request(method: string, params?: unknown): Promise<unknown> {
    const key = await (this.deps.apiKey ?? pimlicoApiKey)();
    const network = (this.deps.network ?? (() => env().PIMLICO_SOLANA_NETWORK))();
    const url = `https://solana.pimlico.io/v1/${network}/rpc?apikey=${encodeURIComponent(key)}`;
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new KoraError(`unreachable: ${redact(String(err), key).slice(0, 200)}`, 'unavailable');
    }
    if (!res.ok) throw new KoraError(`HTTP ${res.status}`, 'unavailable');
    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new KoraError('invalid JSON response', 'unavailable');
    }
    if (body?.error) {
      const msg = typeof body.error.message === 'string' ? body.error.message : 'error';
      throw new KoraError(
        `${String(body.error.code)} ${redact(msg, key).slice(0, 300)}`,
        'refused',
      );
    }
    return body?.result ?? null;
  }

  async payerSigner(): Promise<string> {
    const r = z
      .object({ signer_address: z.string() })
      .safeParse(await this.request('getPayerSigner'));
    if (!r.success || !isSolanaAddress(r.data.signer_address)) {
      throw new KoraError('unexpected getPayerSigner result', 'unavailable');
    }
    return r.data.signer_address;
  }

  async blockhash(): Promise<string> {
    const r = z.object({ blockhash: z.string() }).safeParse(await this.request('getBlockhash'));
    if (!r.success || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.data.blockhash)) {
      throw new KoraError('unexpected getBlockhash result', 'unavailable');
    }
    return r.data.blockhash;
  }

  /** The paymaster signs as fee payer and returns the transaction (base64); nothing is sent. */
  async signTransaction(transaction: string): Promise<string> {
    const r = z
      .object({ signed_transaction: z.string().max(1700) })
      .safeParse(await this.request('signTransaction', { transaction }));
    if (!r.success) throw new KoraError('unexpected signTransaction result', 'unavailable');
    return r.data.signed_transaction;
  }
}

/** A base58 transaction signature (64 bytes). */
export function isSignature(s: string): boolean {
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}

const TokenBalanceSchema = z.object({
  accountIndex: z.number().int(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
});
export type TokenBalance = z.infer<typeof TokenBalanceSchema>;

const TransactionSchema = z.object({
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({ accountKeys: z.array(z.string()) }).optional(),
  }),
  meta: z
    .object({
      err: z.unknown(),
      fee: z.number().int().nonnegative(),
      preBalances: z.array(z.number()),
      postBalances: z.array(z.number()),
      computeUnitsConsumed: z.number().int().optional(),
      preTokenBalances: z.array(TokenBalanceSchema).nullish(),
      postTokenBalances: z.array(TokenBalanceSchema).nullish(),
    })
    .nullable(),
});
export type SolanaTransaction = z.infer<typeof TransactionSchema>;

const StatusSchema = z
  .object({ err: z.unknown(), confirmationStatus: z.string().nullish() })
  .nullable();

/** The node refused or failed a call; `code` is the JSON-RPC error code when it gave one. */
export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'SolanaRpcError';
  }

  /**
   * `sendTransaction`'s preflight refused the transaction (simulation failed, -32002, or a
   * signature failed verification, -32003): the node did not forward it. Not when the reason is
   * that it was already processed (a gateway retry after the first send got through).
   */
  get preflightRefused(): boolean {
    if (this.code !== -32002 && this.code !== -32003) return false;
    return !/already (been )?processed|AlreadyProcessed/i.test(this.message);
  }
}

export class SolanaRpc {
  constructor(
    private readonly url: string = env().SOLANA_RPC_URL,
    private readonly fetchImpl: typeof fetch = (u, i) => fetch(u, i),
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new SolanaRpcError(`Solana RPC HTTP ${res.status}`, null);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (body?.error) {
      throw new SolanaRpcError(
        `Solana RPC error: ${String(body.error.message).slice(0, 200)}`,
        typeof body.error.code === 'number' ? body.error.code : null,
      );
    }
    return body?.result ?? null;
  }

  /** Whether each account exists. */
  async accountsExist(addresses: string[]): Promise<boolean[]> {
    const r = (await this.call('getMultipleAccounts', [
      addresses,
      { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } },
    ])) as { value?: unknown[] } | null;
    const value = r?.value;
    if (!Array.isArray(value) || value.length !== addresses.length) {
      throw new Error('unexpected getMultipleAccounts result');
    }
    return value.map((v) => v !== null);
  }

  /** Broadcasts a fully signed transaction (base64); re-sending the same bytes is harmless. */
  async sendTransaction(transaction: string): Promise<string> {
    const r = await this.call('sendTransaction', [
      transaction,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 2,
      },
    ]);
    if (typeof r !== 'string') throw new SolanaRpcError('unexpected sendTransaction result', null);
    return r;
  }

  async signatureStatus(signature: string): Promise<z.infer<typeof StatusSchema>> {
    const r = (await this.call('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ])) as { value?: unknown[] } | null;
    return StatusSchema.parse(r?.value?.[0] ?? null);
  }

  async transaction(signature: string): Promise<SolanaTransaction | null> {
    const raw = await this.call('getTransaction', [
      signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    return raw === null ? null : TransactionSchema.parse(raw);
  }

  /**
   * Whether the blockhash is still valid at the finalized root: once it is not, no fork can still
   * include a transaction using it.
   */
  async isBlockhashValid(blockhash: string): Promise<boolean> {
    const r = (await this.call('isBlockhashValid', [blockhash, { commitment: 'finalized' }])) as {
      value?: unknown;
    } | null;
    if (typeof r?.value !== 'boolean') throw new Error('unexpected isBlockhashValid result');
    return r.value;
  }
}
