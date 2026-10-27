// Test-mode 1Click (`livemode=false`). Deterministic: prices come from a fixture table, deposit
// addresses and tx hashes are hashes of their inputs, and time comes from an injectable clock.
// Nothing touches a network. `simulate()` stands in for the shopper's deposit and 1Click's
// processing; on settlement it credits the merchant's test intents account (and Tendr's test fee
// account) through the mock intents verifier's test-only `deposit(account_id, token_id, amount)`,
// via the test-mode NEAR client (the in-memory fake in tests and local dev).
//
// State lives in a SimStore: Redis by default (`sim1click:<depositAddress>`, 48 h TTL), so the
// API process (the test-mode `simulate` route) and the worker (status polls) see the same
// deposits. Unit tests may pass a MemorySimStore.
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { env } from '../../env.js';
import { nearClient, type NearClient, type TxStatusResult } from '../../near/client.js';
import { eventLog } from '../../near/events.js';
import { RedisSimStore, type SimDeposit, type SimStore } from './sim-store.js';
import {
  OneClickError,
  type OneClickProvider,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
  type TokenInfo,
} from './types.js';

export const SIMULATE_SCENARIOS = [
  'exact',
  'underpay',
  'overpay',
  'late',
  'failed',
  /** Sends the rest after an `underpay`, before the deadline (spec "Changes" #8). */
  'topup',
] as const;
export type SimulateScenario = (typeof SIMULATE_SCENARIOS)[number];

/** 1Click's own fee in the simulation, basis points (on top of any `appFees`). */
export const SIM_ONECLICK_FEE_BPS = 10;

interface FixtureToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  /** USD price in millionths (micro-USD). */
  priceMicroUsd: bigint;
}

const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1_000_000));

/** Fixed prices. Both 1Click mainnet ids and the ids the test fixtures use. */
export const SIM_TOKENS: readonly FixtureToken[] = [
  // Test fixtures.
  {
    assetId: 'nep141:usdc.test',
    symbol: 'USDC',
    blockchain: 'near',
    decimals: 6,
    priceMicroUsd: usd(1),
  },
  {
    assetId: 'nep141:eth.test',
    symbol: 'ETH',
    blockchain: 'eth',
    decimals: 18,
    priceMicroUsd: usd(2500),
  },
  {
    assetId: 'nep141:usdc.tendr.testnet',
    symbol: 'USDC',
    blockchain: 'near',
    decimals: 6,
    priceMicroUsd: usd(1),
  },
  {
    // The testnet USDC stand-in the dashboard knows (web asset-registry), and the test-mode
    // settlement default (accounts/settlement.ts).
    assetId: 'nep141:usdc.fakes.testnet',
    symbol: 'USDC',
    blockchain: 'near',
    decimals: 6,
    priceMicroUsd: usd(1),
  },
  {
    assetId: 'nep141:wrap.testnet',
    symbol: 'wNEAR',
    blockchain: 'near',
    decimals: 24,
    priceMicroUsd: usd(3),
  },
  // 1Click mainnet ids.
  {
    assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    symbol: 'USDC',
    blockchain: 'near',
    decimals: 6,
    priceMicroUsd: usd(1),
  },
  {
    assetId: 'nep141:usdt.tether-token.near',
    symbol: 'USDT',
    blockchain: 'near',
    decimals: 6,
    priceMicroUsd: usd(1),
  },
  {
    assetId: 'nep141:wrap.near',
    symbol: 'wNEAR',
    blockchain: 'near',
    decimals: 24,
    priceMicroUsd: usd(3),
  },
  {
    assetId: 'nep141:eth.omft.near',
    symbol: 'ETH',
    blockchain: 'eth',
    decimals: 18,
    priceMicroUsd: usd(2500),
  },
  {
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    symbol: 'USDC',
    blockchain: 'eth',
    decimals: 6,
    priceMicroUsd: usd(1),
  },
  {
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    symbol: 'USDC',
    blockchain: 'base',
    decimals: 6,
    priceMicroUsd: usd(1),
  },
  {
    assetId: 'nep141:base.omft.near',
    symbol: 'ETH',
    blockchain: 'base',
    decimals: 18,
    priceMicroUsd: usd(2500),
  },
  {
    assetId: 'nep141:btc.omft.near',
    symbol: 'BTC',
    blockchain: 'btc',
    decimals: 8,
    priceMicroUsd: usd(60000),
  },
  {
    assetId: 'nep141:sol.omft.near',
    symbol: 'SOL',
    blockchain: 'sol',
    decimals: 9,
    priceMicroUsd: usd(150),
  },
];

const EVM_CHAINS = new Set(['eth', 'base', 'arb', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera']);

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
const hex = (s: string, bytes: number): string => sha256(s).subarray(0, bytes).toString('hex');

/** Deterministic destination (NEAR) tx hash of a simulated settlement, base58 like a real one. */
export function simulatedDestinationTxHash(depositAddress: string): string {
  return bs58.encode(sha256(`sim-dest:${depositAddress}`));
}

/** Deterministic origin-chain tx hash of the n-th simulated deposit to an address. */
export function simulatedOriginTxHash(depositAddress: string, n: number): string {
  return `0x${hex(`sim-origin:${depositAddress}:${n}`, 32)}`;
}

/** Deterministic sender of simulated deposits to an address (EVM-shaped). */
export function simulatedSenderAddress(depositAddress: string): string {
  return `0x${hex(`sim-sender:${depositAddress}`, 20)}`;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Micro-USD → decimal string without trailing zeros ("25.15", "25"). */
function formatUsd(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface SimulatedOneClickOptions {
  now?: () => Date;
  /** Test-mode NEAR client; defaults to `nearClient(false)`, resolved on each use. */
  near?: () => NearClient;
  /** Mock intents verifier; defaults to `INTENTS_CONTRACT_TEST`. */
  intentsContract?: string;
  /** Defaults to Redis (shared across processes). */
  store?: SimStore;
}

export class SimulatedOneClick implements OneClickProvider {
  private readonly now: () => Date;
  private readonly near: () => NearClient;
  private readonly intentsContract: () => string;
  private readonly store: SimStore;

  constructor(opts: SimulatedOneClickOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.near = opts.near ?? (() => nearClient(false));
    const intents = opts.intentsContract;
    this.intentsContract = () => intents ?? env().INTENTS_CONTRACT_TEST;
    this.store = opts.store ?? new RedisSimStore();
  }

  async tokens(): Promise<TokenInfo[]> {
    return SIM_TOKENS.map((t) => ({
      assetId: t.assetId,
      decimals: t.decimals,
      blockchain: t.blockchain,
      symbol: t.symbol,
      priceUsd: formatUsd(t.priceMicroUsd),
    }));
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const origin = token(req.originAsset);
    const dest = token(req.destinationAsset);
    if (!/^\d+$/.test(req.amount) || BigInt(req.amount) === 0n) {
      throw new OneClickError('amount must be a positive integer', 400, 'INVALID_AMOUNT');
    }
    const deadline = new Date(req.deadline);
    if (Number.isNaN(deadline.getTime())) {
      throw new OneClickError('deadline must be an ISO-8601 date', 400, 'INVALID_DEADLINE');
    }
    for (const f of req.appFees ?? []) {
      if (!Number.isInteger(f.fee) || f.fee < 0 || f.fee >= 10_000) {
        throw new OneClickError(
          'appFees[].fee must be an integer number of basis points in [0, 10000)',
          400,
          'INVALID_APP_FEE',
        );
      }
    }
    const feeBps = BigInt(
      SIM_ONECLICK_FEE_BPS + (req.appFees ?? []).reduce((sum, f) => sum + f.fee, 0),
    );

    const amount = BigInt(req.amount);
    let amountIn: bigint, amountOut: bigint, inUsd: bigint, outUsd: bigint;
    if (req.swapType === 'EXACT_OUTPUT') {
      amountOut = amount;
      outUsd = (amountOut * dest.priceMicroUsd) / pow10(dest.decimals);
      inUsd = ceilDiv(outUsd * (10_000n + feeBps), 10_000n);
      amountIn = ceilDiv(inUsd * pow10(origin.decimals), origin.priceMicroUsd);
    } else {
      amountIn = amount;
      inUsd = (amountIn * origin.priceMicroUsd) / pow10(origin.decimals);
      outUsd = (inUsd * 10_000n) / (10_000n + feeBps);
      amountOut = (outUsd * pow10(dest.decimals)) / dest.priceMicroUsd;
    }

    const fingerprint = JSON.stringify(req);
    const depositAddress = req.dry
      ? undefined
      : EVM_CHAINS.has(origin.blockchain)
        ? `0x${hex(`sim-deposit:${fingerprint}`, 20)}`
        : hex(`sim-deposit:${fingerprint}`, 32);
    // The address is a hash of the request, so an identical request gets the same address; it
    // keeps whatever state its deposit already reached.
    if (depositAddress) {
      await this.store.create(depositAddress, {
        req: structuredClone(req),
        amountIn,
        amountOut,
        deadline,
        status: 'PENDING_DEPOSIT',
        deposited: 0n,
        refunded: 0n,
        origin: [],
        settled: false,
        credited: [],
      });
    }
    return {
      quote: {
        ...(depositAddress ? { depositAddress } : {}),
        amountIn: amountIn.toString(),
        amountInUsd: formatUsd(inUsd),
        amountOut: amountOut.toString(),
        amountOutUsd: formatUsd(outUsd),
        minAmountIn: amountIn.toString(),
        deadline: deadline.toISOString(),
        timeWhenInactive: deadline.toISOString(),
      },
      correlationId: `sim-${hex(`sim-corr:${fingerprint}`, 16)}`,
    };
  }

  /** Read-only: an incomplete deposit past its deadline reads as REFUNDED without a write. */
  async status(depositAddress: string): Promise<StatusResponse> {
    const d = await this.get(depositAddress);
    this.expire(d);
    return view(depositAddress, d);
  }

  async submitDeposit(txHash: string, depositAddress: string): Promise<void> {
    await this.store.withLock(depositAddress, async () => {
      const d = await this.get(depositAddress);
      if (!d.origin.some((h) => h.hash === txHash)) d.origin.push({ hash: txHash });
      if (d.status === 'PENDING_DEPOSIT') d.status = 'KNOWN_DEPOSIT_TX';
      await this.store.put(depositAddress, d);
    });
  }

  /**
   * Simulates a deposit to `depositAddress` and 1Click processing it:
   * - `exact` → SUCCESS; `overpay` → SUCCESS, the 10% excess refunded;
   * - `underpay` → INCOMPLETE_DEPOSIT (half the amount), REFUNDED once the deadline passes;
   * - `topup` → after `underpay` and before the deadline, sends the rest → SUCCESS;
   * - `late`, or any deposit after the deadline → REFUNDED, never credited;
   * - `failed` → FAILED.
   * SUCCESS credits the recipient (`recipientType INTENTS`) and each `appFees` recipient through
   * the mock verifier's `deposit` first; if that fails, the deposit stays as it was and this
   * throws. `senderAddress` overrides the simulated sender (e.g. a sanctioned address).
   * Holds the address's store lock throughout, so concurrent calls (any process) cannot settle
   * twice; a concurrent call fails with 409 `BUSY`.
   */
  async simulate(
    depositAddress: string,
    scenario: SimulateScenario,
    opts: { senderAddress?: string } = {},
  ): Promise<StatusResponse> {
    return this.store.withLock(depositAddress, () =>
      this.simulateLocked(depositAddress, scenario, opts),
    );
  }

  private async simulateLocked(
    depositAddress: string,
    scenario: SimulateScenario,
    opts: { senderAddress?: string },
  ): Promise<StatusResponse> {
    const d = await this.get(depositAddress);
    this.expire(d);
    if (scenario === 'topup') {
      if (d.status !== 'INCOMPLETE_DEPOSIT') {
        throw invalidState(`topup needs an INCOMPLETE_DEPOSIT, not ${d.status}`);
      }
    } else if (d.status !== 'PENDING_DEPOSIT' && d.status !== 'KNOWN_DEPOSIT_TX') {
      throw invalidState(`deposit address is already ${d.status}`);
    }

    const sender = opts.senderAddress ?? d.senderAddress ?? simulatedSenderAddress(depositAddress);
    const late = scenario === 'late' || this.now() > d.deadline;
    const add =
      scenario === 'topup'
        ? d.amountIn - d.deposited
        : scenario === 'underpay'
          ? d.amountIn / 2n
          : scenario === 'overpay'
            ? d.amountIn + (d.amountIn / 10n > 0n ? d.amountIn / 10n : 1n)
            : d.amountIn;

    const next: SimDeposit = {
      ...d,
      origin: [...d.origin, { hash: simulatedOriginTxHash(depositAddress, d.origin.length + 1) }],
      senderAddress: sender,
      deposited: d.deposited + add,
    };
    if (late) {
      next.status = 'REFUNDED';
      next.refunded = next.deposited;
      next.refundReason = 'Deposit arrived after the quote deadline (simulated)';
    } else if (scenario === 'failed') {
      next.status = 'FAILED';
    } else if (next.deposited < d.amountIn) {
      next.status = 'INCOMPLETE_DEPOSIT';
    } else {
      // Credits are saved on the stored (pre-deposit) state as they happen, so a retry after a
      // partial failure skips recipients already credited.
      await this.settle(depositAddress, d);
      await this.store.putDestination(simulatedDestinationTxHash(depositAddress), depositAddress);
      next.credited = d.credited;
      next.status = 'SUCCESS';
      next.settled = true;
      next.refunded = next.deposited - d.amountIn;
    }
    await this.store.put(depositAddress, next);
    return view(depositAddress, next);
  }

  /** `d` is the stored state; each successful credit is recorded on it and saved at once. */
  private async settle(depositAddress: string, d: SimDeposit): Promise<void> {
    if (d.req.recipientType !== 'INTENTS') return;
    const credits = [
      { id: 'recipient', account: d.req.recipient, amount: d.amountOut },
      ...(d.req.appFees ?? []).map((f, i) => ({
        id: `fee:${i}`,
        account: f.recipient,
        amount: (d.amountOut * BigInt(f.fee)) / 10_000n,
      })),
    ].filter((c) => c.amount > 0n && !d.credited.includes(c.id));
    const client = this.near();
    const intents = this.intentsContract();
    for (const c of credits) {
      const res = await client.call('relayer-accounts', intents, 'deposit', {
        account_id: c.account,
        token_id: d.req.destinationAsset,
        amount: c.amount.toString(),
      });
      if (res.topLevelStatus !== 'success') {
        throw new Error(
          `simulated settlement: mock verifier deposit to ${c.account} failed: ${res.failure ?? 'unknown'}`,
        );
      }
      d.credited = [...d.credited, c.id];
      await this.store.put(depositAddress, d);
    }
  }

  /**
   * The simulated destination (NEAR) transaction of a settled deposit, as `EXPERIMENTAL_tx_status`
   * would report it; null for any other hash. `INTENTS` recipients: one intents-contract receipt
   * with a NEP-245 `mt_mint` per credit (merchant, then each app fee), as the mock verifier's
   * `deposit` emits. `DESTINATION_CHAIN` with a `nep141:` asset: a NEP-141 `ft_transfer` from the
   * token contract to the payout address.
   */
  async destinationTx(txHash: string): Promise<TxStatusResult | null> {
    const depositAddress = await this.store.getDestination(txHash);
    if (!depositAddress) return null;
    const d = await this.store.get(depositAddress);
    if (!d || !d.settled) return null;
    const relayer = 'sim-1click-relayer.testnet';
    if (d.req.recipientType === 'INTENTS') {
      const intents = this.intentsContract();
      const credits = [
        { account: d.req.recipient, amount: d.amountOut },
        ...(d.req.appFees ?? []).map((f) => ({
          account: f.recipient,
          amount: (d.amountOut * BigInt(f.fee)) / 10_000n,
        })),
      ].filter((c) => c.amount > 0n);
      return {
        hash: txHash,
        signerId: relayer,
        receiverId: intents,
        receipts: [
          {
            receiptId: `${txHash}-0`,
            executorId: intents,
            ok: true,
            logs: credits.map((c) =>
              eventLog('nep245', '1.0.0', 'mt_mint', [
                {
                  owner_id: c.account,
                  token_ids: [d.req.destinationAsset],
                  amounts: [c.amount.toString()],
                },
              ]),
            ),
          },
        ],
      };
    }
    if (!d.req.destinationAsset.startsWith('nep141:')) return null;
    const token = d.req.destinationAsset.slice('nep141:'.length);
    return {
      hash: txHash,
      signerId: relayer,
      receiverId: token,
      receipts: [
        {
          receiptId: `${txHash}-0`,
          executorId: token,
          ok: true,
          logs: [
            eventLog('nep141', '1.0.0', 'ft_transfer', [
              {
                old_owner_id: relayer,
                new_owner_id: d.req.recipient,
                amount: d.amountOut.toString(),
              },
            ]),
          ],
        },
      ],
    };
  }

  /** An incomplete deposit still short when the deadline passes is refunded. */
  private expire(d: SimDeposit): void {
    if (d.status === 'INCOMPLETE_DEPOSIT' && this.now() > d.deadline) {
      d.status = 'REFUNDED';
      d.refunded = d.deposited;
      d.refundReason = 'Deposit below the quoted amount; refunded at the deadline (simulated)';
    }
  }

  private async get(depositAddress: string): Promise<SimDeposit> {
    const d = await this.store.get(depositAddress);
    if (!d) throw new OneClickError('deposit address not found', 404, 'NOT_FOUND');
    return d;
  }
}

function token(assetId: string): FixtureToken {
  const t = SIM_TOKENS.find((x) => x.assetId === assetId);
  if (!t) throw new OneClickError(`unsupported asset ${assetId}`, 400, 'UNSUPPORTED_ASSET');
  return t;
}

function invalidState(message: string): OneClickError {
  return new OneClickError(message, 409, 'INVALID_STATE');
}

function view(depositAddress: string, d: SimDeposit): StatusResponse {
  const started = d.status !== 'PENDING_DEPOSIT' && d.status !== 'KNOWN_DEPOSIT_TX';
  return {
    status: d.status,
    swapDetails: {
      originChainTxHashes: d.origin.map((h) => ({ ...h })),
      destinationChainTxHashes: d.settled
        ? [{ hash: simulatedDestinationTxHash(depositAddress) }]
        : [],
      ...(started
        ? {
            amountIn: d.amountIn.toString(),
            amountOut: d.status === 'SUCCESS' ? d.amountOut.toString() : '0',
            depositedAmount: d.deposited.toString(),
            refundedAmount: d.refunded.toString(),
          }
        : {}),
      ...(d.refundReason ? { refundReason: d.refundReason } : {}),
      ...(d.senderAddress ? { senderAddress: d.senderAddress } : {}),
    },
  };
}
