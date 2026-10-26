// Who sent a deposit, read from the origin-chain transactions (live mode only: test mode uses the
// simulated provider's `senderAddress`). One resolver per chain family behind one interface.
// Every resolver screens the union of the transaction's SIGNER and the actual SOURCE of the funds
// that reached the deposit address (a relayer / fee payer can differ from the token owner):
//
//   EVM      eth_getTransactionByHash `from` + every ERC-20 Transfer log `from` whose `to` is the
//            deposit address (eth_getTransactionReceipt) + every ERC-4337 UserOperationEvent
//            sender; a native deposit not sent straight to the deposit address also screens
//            tx.to (the smart account / contract that forwarded it). RPC per chain:
//            EVM_RPC_URLS over public defaults.
//   Solana   getTransaction (jsonParsed): the fee payer + the source / authority / owner of every
//            SOL or SPL transfer into the deposit address (inner instructions included).
//   Tron     TronGrid gettransactionbyid owner_address + every TRC-20 Transfer `from` whose `to`
//            is the deposit address (gettransactioninfobyid), base58.
//   Bitcoin  mempool.space: every distinct input's prevout address.
//   NEAR     the signer + NEP-366 delegate senders + `old_owner_id` of every NEP-141 / NEP-245
//            transfer event into the deposit address (and the predecessor of that receipt).
//
// Fail closed: if ANY transaction cannot be read, or yields no sender, the resolver returns [] —
// never a partial list. [] means "unknown": the payment waits in SCREENING_PENDING.
// Every HTTP call has a 5 s timeout and needs no API key.
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { env } from '../../env.js';
import { log } from '../../lib/logger.js';
import type { NearClient } from '../../near/client.js';
import { creditsOf, parseEventLog } from '../../near/events.js';
import { chainFamily } from '../address-format.js';

export const SENDER_LOOKUP_TIMEOUT_MS = 5_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SenderLookupInput {
  /** 1Click `blockchain` id of the origin asset ("eth", "sol", "tron", "btc", "near", …). */
  chain: string;
  /** 1Click origin asset id (NEAR uses its token contract to route the lookup). */
  originAsset: string;
  /** The quote's deposit address (transfers INTO it identify the source of funds). */
  depositAddress: string;
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
/** keccak256("Transfer(address,address,uint256)"): ERC-20 and TRC-20 Transfer topic. */
export const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const unique = (xs: string[]) => [...new Set(xs)];

/**
 * Runs `one` for every tx hash. All or nothing: a hash that throws or yields no sender makes the
 * whole lookup [] (unknown), so a partial list can never pass as the complete set of senders.
 */
async function everyHash(
  family: string,
  hashes: string[],
  one: (hash: string) => Promise<string[]>,
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const found: string[] = [];
  for (const hash of hashes) {
    let senders: string[];
    try {
      senders = await one(hash);
    } catch (err) {
      log('warn', 'sender lookup failed', { family, hash, err: String(err) });
      return [];
    }
    if (senders.length === 0) {
      log('warn', 'sender lookup found no sender', { family, hash });
      return [];
    }
    found.push(...senders);
  }
  return unique(found);
}

// ─── EVM ─────────────────────────────────────────────────────────────────────

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
/** The address in a 32-byte topic (last 20 bytes), lower-case 0x form. */
const topicAddress = (t: unknown): string | null =>
  typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t) ? `0x${t.slice(26).toLowerCase()}` : null;

/** keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"). */
export const USER_OPERATION_EVENT_TOPIC =
  '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
/** ERC-4337 EntryPoint deployments (v0.6, v0.7, v0.8), lower-case: the same on every EVM chain. */
export const ENTRY_POINTS: ReadonlySet<string> = new Set([
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
]);

export class EvmSenderResolver implements SenderResolver {
  constructor(
    private readonly urls: () => Record<string, string> = () => evmRpcUrls(),
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  private async rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
    const body = obj(
      await postJson(this.fetchImpl, url, { jsonrpc: '2.0', id: 1, method, params }),
    );
    if (body?.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body?.result;
  }

  async resolve(input: SenderLookupInput): Promise<string[]> {
    const url = this.urls()[input.chain.toLowerCase()];
    if (!url) {
      log('warn', 'sender lookup: no RPC for EVM chain', { chain: input.chain });
      return [];
    }
    const deposit = input.depositAddress.toLowerCase();
    return everyHash('evm', input.originTxHashes, async (hash) => {
      const tx = obj(await this.rpc(url, 'eth_getTransactionByHash', [hash]));
      const from = str(tx?.from);
      if (!from || !EVM_ADDR.test(from)) return [];
      const receipt = obj(await this.rpc(url, 'eth_getTransactionReceipt', [hash]));
      if (!receipt) throw new Error('no receipt yet');
      const sources: string[] = [];
      const userOpSenders: string[] = [];
      let tokenIn = false;
      for (const raw of arr(receipt.logs)) {
        const topics = arr(obj(raw)?.topics);
        const topic0 = String(topics[0]).toLowerCase();
        if (topic0 === USER_OPERATION_EVENT_TOPIC) {
          // ERC-4337: tx.from is only the bundler; the smart account (indexed `sender`) is the
          // real payer, and is screened too (T7).
          const sender = topicAddress(topics[2]);
          if (sender) userOpSenders.push(sender);
          continue;
        }
        if (topic0 !== `0x${TRANSFER_TOPIC}`) continue;
        const src = topicAddress(topics[1]);
        const dst = topicAddress(topics[2]);
        if (src && dst === deposit) {
          sources.push(src);
          tokenIn = true;
        }
      }
      const to = str(tx?.to)?.toLowerCase() ?? null;
      const viaEntryPoint = to !== null && ENTRY_POINTS.has(to);
      // An EntryPoint call whose user-op sender cannot be read: the real payer is unknown.
      if (viaEntryPoint && userOpSenders.length === 0) return [];
      if (!tokenIn && !viaEntryPoint && to !== deposit) {
        // A native deposit that did not go straight to the deposit address reached it through an
        // internal call of the contract the tx called (a smart account executed by its owner, a
        // router): that contract is a source too. With no `to` at all it cannot be told: unknown.
        if (to === null || !EVM_ADDR.test(to)) return [];
        sources.push(to);
      }
      return unique([from.toLowerCase(), ...userOpSenders, ...sources]);
    });
  }
}

// ─── Solana ──────────────────────────────────────────────────────────────────

export class SolanaSenderResolver implements SenderResolver {
  constructor(
    private readonly url: string = SOLANA_RPC_URL,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    const deposit = input.depositAddress;
    return everyHash('solana', input.originTxHashes, async (sig) => {
      const body = obj(
        await postJson(this.fetchImpl, this.url, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            sig,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
          ],
        }),
      );
      const result = obj(body?.result);
      const message = obj(obj(result?.transaction)?.message);
      const keys = arr(message?.accountKeys).map((k) => str(obj(k)?.pubkey) ?? str(k));
      const feePayer = keys[0];
      if (!feePayer) return [];
      const meta = obj(result?.meta);
      // Token account → owner, from the balances 1Click's deposit touched.
      const owners = new Map<string, string>();
      for (const b of [...arr(meta?.preTokenBalances), ...arr(meta?.postTokenBalances)]) {
        const ob = obj(b);
        const idx = typeof ob?.accountIndex === 'number' ? ob.accountIndex : -1;
        const account = keys[idx];
        const owner = str(ob?.owner);
        if (account && owner) owners.set(account, owner);
      }
      const instructions = [
        ...arr(message?.instructions),
        ...arr(meta?.innerInstructions).flatMap((i) => arr(obj(i)?.instructions)),
      ];
      const sources: string[] = [];
      for (const raw of instructions) {
        const ins = obj(raw);
        const parsed = obj(ins?.parsed);
        const info = obj(parsed?.info);
        const type = str(parsed?.type);
        if (!info || !type) continue;
        const program = str(ins?.program);
        if (program === 'system' && type === 'transfer' && info.destination === deposit) {
          const source = str(info.source);
          if (source) sources.push(source);
        }
        if (
          (program === 'spl-token' || program === 'spl-token-2022') &&
          (type === 'transfer' || type === 'transferChecked')
        ) {
          const dest = str(info.destination);
          if (!dest || (dest !== deposit && owners.get(dest) !== deposit)) continue;
          for (const who of [info.authority, info.multisigAuthority]) {
            const w = str(who);
            if (w) sources.push(w);
          }
          const srcOwner = owners.get(str(info.source) ?? '');
          if (srcOwner) sources.push(srcOwner);
        }
      }
      return unique([feePayer, ...sources]);
    });
  }
}

// ─── Tron ────────────────────────────────────────────────────────────────────

const TRON_B58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();

/** 21-byte Tron hex (`41…`) → base58check address (`T…`). */
export function tronHexToBase58(hex: string): string {
  const payload = Buffer.from(hex, 'hex');
  const check = sha256(sha256(payload)).subarray(0, 4);
  return bs58.encode(Buffer.concat([payload, check]));
}

export class TronSenderResolver implements SenderResolver {
  constructor(
    private readonly url: string = TRONGRID_URL,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    return everyHash('tron', input.originTxHashes, async (hash) => {
      const value = hash.replace(/^0x/i, '');
      const tx = obj(
        await postJson(this.fetchImpl, `${this.url}/wallet/gettransactionbyid`, {
          value,
          visible: true,
        }),
      );
      const contract = obj(arr(obj(tx?.raw_data)?.contract)[0]);
      const owner = str(obj(obj(contract?.parameter)?.value)?.owner_address);
      if (!owner || !TRON_B58.test(owner)) return [];
      const info = obj(
        await postJson(this.fetchImpl, `${this.url}/wallet/gettransactioninfobyid`, { value }),
      );
      // TronGrid answers `{}` until the tx is confirmed: unknown (retry), never signer-only (M-4).
      if (!info || typeof info.id !== 'string') throw new Error('no transaction info yet');
      const sources: string[] = [];
      for (const raw of arr(info.log)) {
        const topics = arr(obj(raw)?.topics).map((t) => String(t).toLowerCase());
        if (topics[0] !== TRANSFER_TOPIC || !topics[1] || !topics[2]) continue;
        const from = tronHexToBase58(`41${topics[1].slice(24)}`);
        const to = tronHexToBase58(`41${topics[2].slice(24)}`);
        if (to === input.depositAddress) sources.push(from);
      }
      return unique([owner, ...sources]);
    });
  }
}

// ─── Bitcoin ─────────────────────────────────────────────────────────────────

export class BitcoinSenderResolver implements SenderResolver {
  constructor(
    private readonly url: string = MEMPOOL_URL,
    private readonly fetchImpl: FetchLike = realFetch,
  ) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    return everyHash('bitcoin', input.originTxHashes, async (txid) => {
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error('not a bitcoin txid');
      const body = obj(await getJson(this.fetchImpl, `${this.url}/api/tx/${txid}`));
      // Every input's owner is a sender; each is screened.
      return unique(
        arr(body?.vin)
          .map((i) => str(obj(obj(i)?.prevout)?.scriptpubkey_address))
          .filter((a): a is string => a !== null),
      );
    });
  }
}

// ─── NEAR ────────────────────────────────────────────────────────────────────

export class NearSenderResolver implements SenderResolver {
  constructor(private readonly near: () => NearClient) {}

  async resolve(input: SenderLookupInput): Promise<string[]> {
    const contract = input.originAsset.startsWith('nep141:')
      ? input.originAsset.slice(7)
      : undefined;
    return everyHash('near', input.originTxHashes, async (hash) => {
      const tx = await this.near().txStatus(hash, contract);
      if (!tx?.signerId) return [];
      const sources: string[] = [...(tx.delegateSenderIds ?? [])];
      for (const r of tx.receipts) {
        if (!r.ok) continue;
        for (const line of r.logs) {
          const e = parseEventLog(line);
          if (!e || !Array.isArray(e.data)) continue;
          const intoDeposit = creditsOf(e, r.executorId).some(
            (c) => c.receiver === input.depositAddress,
          );
          if (!intoDeposit) continue;
          for (const d of e.data as unknown[]) {
            const old = str(obj(d)?.old_owner_id);
            if (old) sources.push(old);
          }
          if (r.predecessorId && r.predecessorId !== r.executorId) sources.push(r.predecessorId);
        }
      }
      return unique([tx.signerId, ...sources]);
    });
  }
}

// ─── dispatch ────────────────────────────────────────────────────────────────

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
