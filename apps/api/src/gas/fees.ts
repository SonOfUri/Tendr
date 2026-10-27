// Network-fee pricing for gasless payments (project 5a, spec §2.5).
//
// `estimateNetworkFeeUsd` quotes the live cost of one payment's on-chain transaction per chain:
//   EVM     eth_gasPrice × the method's gas units (EVM_GAS_UNITS)
//   Solana  5000 lamports per signature + the median recent priority fee × SOLANA_COMPUTE_UNITS
//   NEAR    gas_price × the method's gas units (NEAR_GAS_UNITS)
//   Tron    the energy price (getEnergyFee) × the method's energy + a bandwidth allowance
// priced in USD at the native coin's price in the 1Click token list. The per-chain unit price is
// cached for FEE_CACHE_MS. Test mode never calls an RPC: it reads SIMULATED_FEE_USD.
//
// The estimate is the raw cost. Tendr's safety margin (GAS_FEE_MARGIN_BPS) is added where Tendr
// quotes the fee it collects: `withFeeMargin` (USD) and `feeInToken` (token base units).
//
// Money math is exact: decimals are parsed into bigints and every rounding goes UP (a fee is
// something the payer owes).
import type { GaslessMethod } from '@tendr/contracts';
import { chainFamily } from '../checkout/address-format.js';
import { gasEstimateUsd } from '../checkout/gas-estimates.js';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import { evmRpcUrls } from '../checkout/senders/index.js';
import { tokenList } from '../checkout/tokens.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/** A gasless method, or `native`: the shopper's wallet sends normally and pays gas itself. */
export type FeeMethod = GaslessMethod | 'native';

/** How long a chain's unit price (gas price, priority fee, energy price) is reused. */
export const FEE_CACHE_MS = 30_000;
const RPC_TIMEOUT_MS = 5_000;

/** EVM gas per method. EIP-3009 is per authorization (the payment, plus the fee when collected). */
export const EVM_GAS_UNITS = {
  eip3009: 90_000n,
  /** The payment forwarder: permit + signed `TendrPayment` + two `transferFrom`s. */
  permit: 140_000n,
  forwarder: 140_000n,
  /** A sponsored call batch through Pimlico's paymaster (user operation overhead included). */
  paymaster: 180_000n,
  /** A plain ERC-20 transfer from the shopper's wallet. */
  erc20Transfer: 65_000n,
  /** A plain native-coin transfer from the shopper's wallet. */
  nativeTransfer: 21_000n,
} as const;

/** Solana: lamports per signature, and the compute units a payment (+ fee) transfer uses. */
export const SOLANA_SIGNATURE_LAMPORTS = 5_000n;
export const SOLANA_COMPUTE_UNITS = 200_000n;

/** NEAR gas per method (a meta-transaction carries the relayer's delegate action overhead). */
export const NEAR_GAS_UNITS = {
  meta_tx: 50_000_000_000_000n,
  native: 15_000_000_000_000n,
} as const;

/** Tron energy per method: approve + the forwarder's two `transferFrom`s, or one TRC-20 transfer. */
export const TRON_ENERGY_UNITS = { forwarder: 160_000n, native: 65_000n } as const;
/** Bandwidth a Tron transaction burns when the payer has none staked, in sun. */
export const TRON_BANDWIDTH_SUN = 350_000n;

/** Gas the integrator hook call (`onTendrDeposit`) uses; Task 11 refines per chain. */
export const HOOK_GAS_UNITS = 150_000n;
const NEAR_HOOK_GAS = 30_000_000_000_000n;

/**
 * Test-mode network fees (USD) per chain: deterministic, no RPC. Other chains use the static
 * per-family estimate (`checkout/gas-estimates.ts`).
 */
export const SIMULATED_FEE_USD: Readonly<Record<string, string>> = {
  eth: '1.2',
  base: '0.04',
  arb: '0.04',
  op: '0.04',
  pol: '0.02',
  bsc: '0.05',
  avax: '0.06',
  gnosis: '0.01',
  bera: '0.02',
  sol: '0.002',
  near: '0.003',
  tron: '0.8',
};

/** The native coin's symbol(s) per chain, as the 1Click token list names them. */
const NATIVE_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  eth: ['ETH'],
  base: ['ETH'],
  arb: ['ETH'],
  op: ['ETH'],
  pol: ['POL', 'MATIC'],
  bsc: ['BNB'],
  avax: ['AVAX'],
  gnosis: ['XDAI', 'xDAI'],
  bera: ['BERA'],
  sol: ['SOL'],
  near: ['wNEAR', 'NEAR'],
  tron: ['TRX'],
};
const NATIVE_DECIMALS: Readonly<Record<string, number>> = { sol: 9, near: 24, tron: 6 };

const EVM_METHODS = new Set<FeeMethod>(['eip3009', 'permit', 'paymaster', 'forwarder', 'native']);
const METHODS_BY_FAMILY: Readonly<Record<string, ReadonlySet<FeeMethod>>> = {
  evm: EVM_METHODS,
  solana: new Set<FeeMethod>(['kora', 'native']),
  near: new Set<FeeMethod>(['meta_tx', 'native']),
  tron: new Set<FeeMethod>(['forwarder', 'native']),
};

/** Whether `method` can relay a payment on `chain` (spec §2.3); `native` works anywhere. */
export function gaslessMethodSupported(chain: string, method: FeeMethod): boolean {
  if (method === 'native') return true;
  return METHODS_BY_FAMILY[chainFamily(chain)]?.has(method) ?? false;
}

/** Whether the 1Click token is `chain`'s native coin (for the plain-transfer gas estimate). */
export function isNativeToken(token: Pick<TokenInfo, 'blockchain' | 'symbol'>): boolean {
  return NATIVE_SYMBOLS[token.blockchain]?.includes(token.symbol) ?? false;
}

// ---------------------------------------------------------------------------------------------
// Dependencies (injected in tests)
// ---------------------------------------------------------------------------------------------

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface FeeDeps {
  fetch: FetchLike;
  tokens: (livemode: boolean) => Promise<Map<string, TokenInfo>>;
}
const DEFAULT_DEPS: FeeDeps = { fetch: (url, init) => fetch(url, init), tokens: tokenList };
let deps: FeeDeps = DEFAULT_DEPS;

/** Overrides the RPC fetch and the token list (tests); null restores the defaults. */
export function setFeeDeps(overrides: Partial<FeeDeps> | null): void {
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

const priceCache = new Map<string, { at: number; value: bigint }>();

/** Drops the cached unit prices (tests). */
export function resetFeeCache(): void {
  priceCache.clear();
}

// ---------------------------------------------------------------------------------------------
// Exact decimals
// ---------------------------------------------------------------------------------------------

const USD_SCALE = 6;
const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** value = digits / 10^scale */
function parseDecimal(s: string): { digits: bigint; scale: number } | null {
  const m = DECIMAL_RE.exec(s.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  return { digits: BigInt(m[1] + frac), scale: frac.length };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const pow10 = (n: number) => 10n ** BigInt(n);

function microToUsd(micro: bigint): string {
  const whole = micro / pow10(USD_SCALE);
  const frac = (micro % pow10(USD_SCALE)).toString().padStart(USD_SCALE, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

function usdToMicroUp(usd: string): bigint {
  const d = parseDecimal(usd);
  if (!d) throw new TypeError(`Not a USD amount: "${usd}"`);
  return d.scale <= USD_SCALE
    ? d.digits * pow10(USD_SCALE - d.scale)
    : ceilDiv(d.digits, pow10(d.scale - USD_SCALE));
}

function marginBps(): bigint {
  return BigInt(env().GAS_FEE_MARGIN_BPS);
}

/** `usd` plus Tendr's safety margin, rounded up to the micro-dollar (a decimal string). */
export function withFeeMargin(usd: string): string {
  return microToUsd(ceilDiv(usdToMicroUp(usd) * (10_000n + marginBps()), 10_000n));
}

// ---------------------------------------------------------------------------------------------
// Fee in a token
// ---------------------------------------------------------------------------------------------

/**
 * The shopper-paid fee in the payment token: `usd × (1 + GAS_FEE_MARGIN_BPS / 10 000) ÷ the
 * token's 1Click token-list price`, rounded UP to the token's base unit. Never a swap quote.
 * Throws FEE_TOKEN_UNPRICED (400) when the list has no positive price for the token, and
 * UNSUPPORTED_ASSET (400) when it does not list it.
 */
export async function feeInToken(
  assetId: string,
  usd: string,
  opts: { livemode: boolean },
): Promise<{ amount: string; symbol: string; decimals: number }> {
  const token = (await deps.tokens(opts.livemode)).get(assetId);
  if (!token) {
    throw new AppError('UNSUPPORTED_ASSET', `Asset ${assetId} is not supported`, 400, {
      asset: assetId,
    });
  }
  const price = token.priceUsd ? parseDecimal(token.priceUsd) : null;
  if (!price || price.digits === 0n) {
    throw new AppError(
      'FEE_TOKEN_UNPRICED',
      `The network fee cannot be priced in ${token.symbol}`,
      400,
      {
        asset: assetId,
      },
    );
  }
  const fee = parseDecimal(usd);
  if (!fee) throw new TypeError(`Not a USD amount: "${usd}"`);
  // amount = fee.digits/10^fs × (1e4 + m)/1e4 × 10^dec ÷ (price.digits/10^ps)
  const num = fee.digits * (10_000n + marginBps()) * pow10(token.decimals) * pow10(price.scale);
  const den = pow10(fee.scale) * 10_000n * price.digits;
  return { amount: ceilDiv(num, den).toString(), symbol: token.symbol, decimals: token.decimals };
}

// ---------------------------------------------------------------------------------------------
// Live estimates
// ---------------------------------------------------------------------------------------------

function unavailable(chain: string, why: string): AppError {
  return new AppError(
    'NETWORK_FEE_UNAVAILABLE',
    'The network fee cannot be estimated right now',
    503,
    {
      chain,
      reason: why,
    },
  );
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!json || typeof json !== 'object') throw new Error('not a JSON object');
  return json as Record<string, unknown>;
}

const rpcCall = (url: string, method: string, params: unknown[]) =>
  postJson(url, { jsonrpc: '2.0', id: 1, method, params });

/** Reads a non-negative integer from an RPC value (a number, decimal or 0x-hex string). */
function toUnits(v: unknown): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  throw new Error(`not an integer: ${String(v).slice(0, 50)}`);
}

/** The chain's unit price (smallest native unit per gas / CU / energy), cached FEE_CACHE_MS. */
async function unitPrice(chain: string): Promise<bigint> {
  const hit = priceCache.get(chain);
  if (hit && Date.now() - hit.at < FEE_CACHE_MS) return hit.value;
  let value: bigint;
  const family = chainFamily(chain);
  if (family === 'evm') {
    const url = evmRpcUrls()[chain];
    if (!url) throw new Error('no RPC configured');
    value = toUnits((await rpcCall(url, 'eth_gasPrice', [])).result);
  } else if (family === 'solana') {
    const r = await rpcCall(env().SOLANA_RPC_URL, 'getRecentPrioritizationFees', []);
    const fees = (Array.isArray(r.result) ? r.result : [])
      .map((x) => toUnits((x as Record<string, unknown>).prioritizationFee))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    value = fees.length ? fees[Math.floor(fees.length / 2)]! : 0n;
  } else if (family === 'near') {
    const r = await rpcCall(env().NEAR_RPC_URL_LIVE, 'gas_price', [null]);
    value = toUnits((r.result as Record<string, unknown> | undefined)?.gas_price);
  } else if (family === 'tron') {
    const r = await postJson(`${env().TRON_RPC_URL}/wallet/getchainparameters`, {});
    const params = Array.isArray(r.chainParameter) ? r.chainParameter : [];
    const fee = params.find((p) => (p as Record<string, unknown>).key === 'getEnergyFee');
    value = toUnits((fee as Record<string, unknown> | undefined)?.value);
  } else {
    throw new Error('unsupported chain');
  }
  priceCache.set(chain, { at: Date.now(), value });
  return value;
}

/** The transaction's cost in the chain's smallest native unit. */
function nativeCost(
  chain: string,
  method: FeeMethod,
  price: bigint,
  opts: { feeLeg?: boolean; nativeAsset?: boolean },
): bigint {
  switch (chainFamily(chain)) {
    case 'evm': {
      const gas =
        method === 'eip3009'
          ? EVM_GAS_UNITS.eip3009 * (opts.feeLeg ? 2n : 1n)
          : method === 'permit' || method === 'forwarder'
            ? EVM_GAS_UNITS.permit
            : method === 'paymaster'
              ? EVM_GAS_UNITS.paymaster
              : opts.nativeAsset
                ? EVM_GAS_UNITS.nativeTransfer
                : EVM_GAS_UNITS.erc20Transfer;
      return gas * price;
    }
    case 'solana': {
      // Kora: the shopper and the paymaster both sign; a plain send has one signature.
      const signatures = method === 'kora' ? 2n : 1n;
      return (
        signatures * SOLANA_SIGNATURE_LAMPORTS + ceilDiv(price * SOLANA_COMPUTE_UNITS, 1_000_000n)
      );
    }
    case 'near':
      return (method === 'meta_tx' ? NEAR_GAS_UNITS.meta_tx : NEAR_GAS_UNITS.native) * price;
    case 'tron':
      return (
        (method === 'forwarder' ? TRON_ENERGY_UNITS.forwarder : TRON_ENERGY_UNITS.native) * price +
        TRON_BANDWIDTH_SUN
      );
    default:
      throw new Error('unsupported chain');
  }
}

/**
 * USD of `units` of `chain`'s native coin (its smallest unit: wei, lamports, …), rounded up to the
 * micro-dollar, at the 1Click token-list price. Throws NETWORK_FEE_UNAVAILABLE when unpriced.
 */
export async function nativeUsd(chain: string, units: bigint, livemode: boolean): Promise<string> {
  const symbols = NATIVE_SYMBOLS[chain] ?? [];
  const tokens = await deps.tokens(livemode);
  let coin: TokenInfo | undefined;
  for (const t of tokens.values()) {
    if (t.blockchain === chain && symbols.includes(t.symbol) && t.priceUsd) {
      coin = t;
      break;
    }
  }
  const price = coin?.priceUsd ? parseDecimal(coin.priceUsd) : null;
  if (!coin || !price || price.digits === 0n) throw unavailable(chain, 'native coin unpriced');
  const decimals = NATIVE_DECIMALS[chain] ?? coin.decimals;
  // usd micro = units / 10^dec × price.digits / 10^ps × 10^6
  const num = units * price.digits * pow10(USD_SCALE);
  const den = pow10(decimals) * pow10(price.scale);
  return microToUsd(ceilDiv(num, den));
}

/**
 * The live network fee (USD decimal string, no margin) for a payment on `chain` by `method`.
 * `feeLeg`: the transaction also moves a shopper-paid fee (a second EIP-3009 authorization).
 * `nativeAsset`: a plain send of the native coin (`native` method only). Test mode reads
 * SIMULATED_FEE_USD. A chain gasless payments do not cover (e.g. Bitcoin) returns the static
 * estimate for `native` sends. Throws VALIDATION_ERROR (400) for a method the chain cannot use,
 * and NETWORK_FEE_UNAVAILABLE (503) when the RPC or the native price is unavailable.
 */
export async function estimateNetworkFeeUsd(
  chain: string,
  method: FeeMethod,
  opts: { livemode: boolean; feeLeg?: boolean; nativeAsset?: boolean },
): Promise<string> {
  if (!gaslessMethodSupported(chain, method)) {
    throw new AppError('VALIDATION_ERROR', `${method} is not available on ${chain}`, 400, {
      field: 'gasless_method',
    });
  }
  const covered = Object.hasOwn(NATIVE_SYMBOLS, chain);
  if (!opts.livemode) {
    return covered ? SIMULATED_FEE_USD[chain]! : gasEstimateUsd(chain);
  }
  if (!covered) return gasEstimateUsd(chain);
  let price: bigint;
  try {
    price = await unitPrice(chain);
  } catch (err) {
    log('warn', 'network fee: RPC unavailable', { chain, err: String(err) });
    throw unavailable(chain, 'rpc');
  }
  return nativeUsd(chain, nativeCost(chain, method, price, opts), opts.livemode);
}

/**
 * The integrator hook call's estimated cost (USD, no margin) on the settlement `chain`: EVM
 * `HOOK_GAS_UNITS` × gas price, NEAR a fixed 30 Tgas. Test mode reads SIMULATED_FEE_USD. Throws
 * NETWORK_FEE_UNAVAILABLE for any other chain or when the RPC fails.
 */
export async function estimateHookFeeUsd(
  chain: string,
  opts: { livemode: boolean },
): Promise<string> {
  const family = chainFamily(chain);
  if (family !== 'evm' && family !== 'near') throw unavailable(chain, 'no hook on this chain');
  if (!opts.livemode) return SIMULATED_FEE_USD[chain] ?? SIMULATED_FEE_USD.base!;
  let price: bigint;
  try {
    price = await unitPrice(chain);
  } catch (err) {
    log('warn', 'hook fee: RPC unavailable', { chain, err: String(err) });
    throw unavailable(chain, 'rpc');
  }
  const units = (family === 'near' ? NEAR_HOOK_GAS : HOOK_GAS_UNITS) * price;
  return nativeUsd(chain, units, opts.livemode);
}
