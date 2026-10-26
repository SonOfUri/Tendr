// Who sent a deposit, read from the origin-chain transaction (live mode only: test mode uses the
// simulated provider's `senderAddress`). One resolver per chain family behind one interface:
//
//   EVM      eth_getTransactionByHash → `from` (RPC per chain: EVM_RPC_URLS over public defaults)
//   Solana   getTransaction → the first account key (fee payer, first signer)
//   Tron     TronGrid wallet/gettransactionbyid (visible) → owner_address (base58)
//   Bitcoin  mempool.space /api/tx/:txid → every distinct input's prevout address
//   NEAR     EXPERIMENTAL_tx_status → signer (NearClient.txStatus)
//
// A resolver returns every sender it found (Bitcoin may have several; each is screened and any
// `block` holds the payment), or [] when it cannot tell — an unknown chain, an unknown tx, a
// timeout or a malformed answer. [] is never "clean": the payment waits in SCREENING_PENDING.
// Every HTTP call has a 5 s timeout and needs no API key.
import { env } from '../../env.js';
import { log } from '../../lib/logger.js';
import type { NearClient } from '../../near/client.js';
import { chainFamily } from '../address-format.js';

export const SENDER_LOOKUP_TIMEOUT_MS = 5_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SenderLookupInput {
  /** 1Click `blockchain` id of the origin asset ("eth", "sol", "tron", "btc", "near", …). */
  chain: string;
  /** 1Click origin asset id (NEAR uses its token contract to route the lookup). */
  originAsset: string;
  originTxHashes: string[];
}

export interface SenderResolver {
  resolve(input: SenderLookupInput): Promise<string[]>;
}

/** Public mainnet RPCs per 1Click EVM `blockchain` id; EVM_RPC_URLS entries take precedence. */
export const DEFAULT_EVM_RPC_URLS: Readonly<Record<string, string>> = {
  eth: 'https://ethereum-rpc.publicnode.com',
  base: 'https://mainnet.base.org',
  arb: 'https://arb1.arbitrum.io/rpc',
  pol: 'https://polygon-rpc.com',
  bsc: 'https://bsc-dataseed.bnbchain.org',
  op: 'https://mainnet.optimism.io',
  avax: 'https://api.avax.network/ext/bc/C/rpc',
};
/** Long names accepted as EVM_RPC_URLS keys. */
const EVM_ALIASES: Readonly<Record<string, string>> = {
  ethereum: 'eth',
  arbitrum: 'arb',
  polygon: 'pol',
  optimism: 'op',
  avalanche: 'avax',
};
export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const TRONGRID_URL = 'https://api.trongrid.io';
export const MEMPOOL_URL = 'https://mempool.space';

const realFetch: FetchLike = (url, init) => fetch(url, init);

/** The EVM RPC map: public defaults overlaid with EVM_RPC_URLS (aliases normalised). */
export function evmRpcUrls(
  overrides: Record<string, string> = env().EVM_RPC_URLS,
): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_EVM_RPC_URLS };
  for (const [k, v] of Object.entries(overrides)) {
    const key = k.toLowerCase();
    out[EVM_ALIASES[key] ?? key] = v;
  }
  return out;
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(SENDER_LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const postJson = (fetchImpl: FetchLike, url: string, body: unknown) =>
  getJson(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const unique = (xs: string[]) => [...new Set(xs)];

/** Runs `one` per tx hash, keeping going past failures; logs them. */
async function eachHash(
  family: string,
  hashes: string[],
  one: (hash: string) => Promise<string[]>,
): Promise<string[]> {
  const found: string[] = [];
  for (const hash of hashes) {
    try {
      found.push(...(await one(hash)));
    } catch (err) {
      log('warn', 'sender lookup failed', { family, hash, err: String(err) });
    }
  }
  return unique(found);
}

export class EvmSenderResolver implements SenderResolver {
  constructor(
    private readonly urls: () => Record<string, string> = () => evmRpcUrls(),
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    const url = this.urls()[input.chain.toLowerCase()];
    if (!url) {
      log('warn', 'sender lookup: no RPC for EVM chain', { chain: input.chain });
      return [];
    }
    return eachHash('evm', input.originTxHashes, async (hash) => {
      const body = obj(
        await postJson(this.fetchImpl, url, {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionByHash',
          params: [hash],
        }),
      );
      const from = obj(body?.result)?.from;
      return typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from)
        ? [from.toLowerCase()]
        : [];
    });
  }
}

export class SolanaSenderResolver implements SenderResolver {
  constructor(
    private readonly url: string = SOLANA_RPC_URL,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    return eachHash('solana', input.originTxHashes, async (sig) => {
      const body = obj(
        await postJson(this.fetchImpl, this.url, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            sig,
            { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
          ],
        }),
      );
      const message = obj(obj(obj(body?.result)?.transaction)?.message);
      const keys = message?.accountKeys;
      // accountKeys[0] is the fee payer, the first signer of the transaction.
      const first = Array.isArray(keys) ? keys[0] : undefined;
      return typeof first === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(first)
        ? [first]
        : [];
    });
  }
}

export class TronSenderResolver implements SenderResolver {
  constructor(
    private readonly url: string = TRONGRID_URL,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    return eachHash('tron', input.originTxHashes, async (hash) => {
      const body = obj(
        await postJson(this.fetchImpl, `${this.url}/wallet/gettransactionbyid`, {
          value: hash.replace(/^0x/i, ''),
          visible: true,
        }),
      );
      const contracts = obj(body?.raw_data)?.contract;
      const first = Array.isArray(contracts) ? obj(contracts[0]) : null;
      const owner = obj(obj(first?.parameter)?.value)?.owner_address;
      return typeof owner === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(owner) ? [owner] : [];
    });
  }
}

export class BitcoinSenderResolver implements SenderResolver {
  constructor(
    private readonly url: string = MEMPOOL_URL,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    return eachHash('bitcoin', input.originTxHashes, async (txid) => {
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error('not a bitcoin txid');
      const body = obj(await getJson(this.fetchImpl, `${this.url}/api/tx/${txid}`));
      const vin = body?.vin;
      if (!Array.isArray(vin)) return [];
      // Every input's owner is a sender; each is screened.
      return unique(
        vin
          .map((i) => obj(obj(i)?.prevout)?.scriptpubkey_address)
          .filter((a): a is string => typeof a === 'string' && a.length > 0),
      );
    });
  }
}

export class NearSenderResolver implements SenderResolver {
  constructor(private readonly near: () => NearClient) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    const contract = input.originAsset.startsWith('nep141:')
      ? input.originAsset.slice(7)
      : undefined;
    return eachHash('near', input.originTxHashes, async (hash) => {
      const tx = await this.near().txStatus(hash, contract);
      return tx?.signerId ? [tx.signerId] : [];
    });
  }
}

/** Picks the resolver for the origin chain's family; unknown families resolve to []. */
export class SenderResolvers implements SenderResolver {
  constructor(
    private readonly byFamily: Partial<Record<ReturnType<typeof chainFamily>, SenderResolver>>,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    const r = this.byFamily[chainFamily(input.chain)];
    if (!r || input.originTxHashes.length === 0) return [];
    return r.resolve(input);
  }
}

/** The live-mode resolvers (NEAR through the mode's NearClient). */
export function liveSenderResolvers(near: () => NearClient, fetchImpl: FetchLike = realFetch) {
  return new SenderResolvers({
    evm: new EvmSenderResolver(() => evmRpcUrls(), fetchImpl),
    solana: new SolanaSenderResolver(SOLANA_RPC_URL, fetchImpl),
    tron: new TronSenderResolver(TRONGRID_URL, fetchImpl),
    bitcoin: new BitcoinSenderResolver(MEMPOOL_URL, fetchImpl),
    near: new NearSenderResolver(near),
  });
}
