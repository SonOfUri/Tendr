// Gas balance alerts (project 5a, Task 12, spec §2.5 "Relayer funding"): every 15 minutes the
// worker reads the native balance of each relayer key Tendr pays gas from, and Tendr's Pimlico
// balance, and alerts operators when one is worth less than GAS_LOW_BALANCE_USD: one notice per
// account per 6 hours (`opsNotice`). The same tick re-checks the Tendr-wide daily loss cap and
// reuses its once-per-day alert (gas/loss-cap.ts) rather than duplicating it.
//
//   relayer-evm   on every EVM chain with an RPC configured (EIP-3009 / forwarder relays, hooks)
//   gas-tron      on Tron, while the Tron forwarder is configured
//   relayer-near  on NEAR (meta-transactions, registrations, hooks)
//   Pimlico       Tendr's sponsorship balance (EVM paymaster, Solana Kora)
//
// Pimlico documents no balance endpoint, so its reader is injected and defaults to "unknown"
// (logged, no alert) until one is confirmed (README live checklist). Live mode only: test mode
// spends no real gas.
import { Prisma } from '@prisma/client';
import { evmRpcUrls } from '../checkout/senders/index.js';
import { env } from '../env.js';
import { nativeUsd } from '../gas/fees.js';
import { alertLossCapReached, lossCapReached } from '../gas/loss-cap.js';
import { opsNotice } from '../gas/ops-notice.js';
import { getKeyVault } from '../keyvault/index.js';
import { evmAddress } from '../keyvault/secp256k1.js';
import type { KeyName, KeyVault } from '../keyvault/types.js';
import { log } from '../lib/logger.js';
import { relayerNearSender } from '../near/client.js';
import { implicitAccountId } from '../near/tx.js';
import { EvmRpc } from '../relayer/evm/rpc.js';
import { EVM_CHAIN_IDS } from '../relayer/evm/tokens.js';
import { spendableYocto } from '../relayer/near-meta.js';
import { tronAddressOfPublicKey } from '../relayer/tron-tx.js';
import { tronTrxBalance } from './fee-sweep-chains.js';

export const CHECK_GAS_BALANCES_EVERY_MS = 15 * 60_000;
export const GAS_BALANCE_LOW = 'gas.relayer_balance_low';
export const PIMLICO_BALANCE_LOW = 'gas.pimlico_balance_low';

/** One account whose gas Tendr keeps topped up. */
export interface GasAccount {
  key: KeyName;
  chain: string;
  address: string;
}

export interface GasAlertDeps {
  kv: () => KeyVault;
  /** The accounts to check (default: see the file header). */
  accounts: (kv: KeyVault) => Promise<GasAccount[]>;
  /** The account's native balance (smallest unit). */
  nativeBalance: (a: GasAccount) => Promise<bigint>;
  /** USD of native units at the 1Click token-list price. */
  usd: (chain: string, units: bigint) => Promise<string>;
  /** Tendr's Pimlico balance in USD, or null when unknown. */
  pimlicoBalanceUsd: () => Promise<string | null>;
}

async function defaultAccounts(kv: KeyVault): Promise<GasAccount[]> {
  const out: GasAccount[] = [];
  const evm = evmAddress((await kv.publicKey('relayer-evm')).raw);
  const urls = evmRpcUrls();
  for (const chain of Object.keys(EVM_CHAIN_IDS)) {
    if (urls[chain]) out.push({ key: 'relayer-evm', chain, address: evm });
  }
  if (env().TRON_FORWARDER_ADDRESS) {
    out.push({
      key: 'gas-tron',
      chain: 'tron',
      address: tronAddressOfPublicKey((await kv.publicKey('gas-tron')).raw),
    });
  }
  out.push({
    key: 'relayer-near',
    chain: 'near',
    address: implicitAccountId((await kv.publicKey('relayer-near')).raw),
  });
  return out;
}

async function defaultNativeBalance(a: GasAccount): Promise<bigint> {
  if (a.key === 'relayer-evm') {
    const r = await EvmRpc.forChain(a.chain).request('eth_getBalance', [a.address, 'latest']);
    if (typeof r !== 'string' || !/^0x[0-9a-fA-F]+$/.test(r)) throw new Error('bad eth_getBalance');
    return BigInt(r);
  }
  if (a.key === 'gas-tron') return tronTrxBalance(a.address);
  const acct = await relayerNearSender(true).rpc.viewAccountOrNull(a.address);
  return acct ? spendableYocto(acct) : 0n;
}

let pimlicoUnknownLogged = false;

const DEFAULT_DEPS: GasAlertDeps = {
  kv: getKeyVault,
  accounts: defaultAccounts,
  nativeBalance: defaultNativeBalance,
  usd: (chain, units) => nativeUsd(chain, units, true),
  pimlicoBalanceUsd: async () => {
    if (!pimlicoUnknownLogged) {
      pimlicoUnknownLogged = true;
      log('warn', 'gas alerts: Pimlico balance not readable (no documented API); not checked');
    }
    return null;
  },
};
let deps: GasAlertDeps = DEFAULT_DEPS;

/** Overrides the readers (tests); null restores the defaults. */
export function setGasAlertDeps(overrides: Partial<GasAlertDeps> | null): void {
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

export interface GasBalanceReport {
  account: string;
  chain: string;
  key: KeyName | 'pimlico';
  usd: string | null;
  low: boolean;
  /** Whether this check sent the notice (false while throttled). */
  alerted: boolean;
}

/**
 * Reads every relayer key's balance and Tendr's Pimlico balance; one throttled operator notice
 * per low account (6 h). Re-checks the daily loss cap and sends its alert (once per UTC day). A
 * balance that cannot be read is logged and skipped.
 */
export async function checkGasBalances(now: Date = new Date()): Promise<GasBalanceReport[]> {
  const min = new Prisma.Decimal(env().GAS_LOW_BALANCE_USD);
  const reports: GasBalanceReport[] = [];
  let accounts: GasAccount[] = [];
  try {
    accounts = await deps.accounts(deps.kv());
  } catch (err) {
    log('error', 'gas alerts: relayer keys unavailable', { err: String(err) });
  }
  for (const a of accounts) {
    let usd: string;
    let units: bigint;
    try {
      units = await deps.nativeBalance(a);
      usd = await deps.usd(a.chain, units);
    } catch (err) {
      log('warn', 'gas alerts: balance unavailable', {
        key: a.key,
        chain: a.chain,
        err: String(err),
      });
      continue;
    }
    const low = new Prisma.Decimal(usd).lt(min);
    const alerted = low
      ? await opsNotice({
          type: GAS_BALANCE_LOW,
          key: `gas_low:${a.key}:${a.chain}:${a.address}`,
          now,
          payload: {
            key: a.key,
            chain: a.chain,
            address: a.address,
            balance: units.toString(),
            balance_usd: usd,
            threshold_usd: min.toFixed(),
          },
        })
      : false;
    reports.push({ account: a.address, chain: a.chain, key: a.key, usd, low, alerted });
  }
  try {
    const usd = await deps.pimlicoBalanceUsd();
    if (usd !== null) {
      const low = new Prisma.Decimal(usd).lt(min);
      const alerted = low
        ? await opsNotice({
            type: PIMLICO_BALANCE_LOW,
            key: 'gas_low:pimlico',
            now,
            payload: { balance_usd: usd, threshold_usd: min.toFixed() },
          })
        : false;
      reports.push({ account: 'pimlico', chain: 'pimlico', key: 'pimlico', usd, low, alerted });
    }
  } catch (err) {
    log('warn', 'gas alerts: Pimlico balance unavailable', { err: String(err) });
  }
  // The daily loss cap (Task 2): its own once-per-UTC-day alert, reused.
  try {
    if (await lossCapReached(true, now)) await alertLossCapReached(true, now);
  } catch (err) {
    log('warn', 'gas alerts: loss cap check failed', { err: String(err) });
  }
  return reports;
}
