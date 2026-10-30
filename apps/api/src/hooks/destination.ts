// Integrator hooks at session create (project 5a, Task 11, spec §4.1).
//
// `hook_data` (JSON, ≤ 1 KB serialized: `HookDataSchema`) is accepted only for an integrator store
// (`merchants.kind = integrator`) whose settlement destination is a contract on NEAR or a supported
// EVM chain: wallet payout mode (the session's recipient is the store's approved payout address),
// a chain with HOOK_GAS_UNITS, and, in live mode, an address that holds code. It sets
// `delivery = HOOK`; a session without `hook_data` keeps webhook delivery. Kept apart from the
// delivery engine (deliver.ts) so session creation does not load it.
import type { Prisma } from '@prisma/client';
import { evmRpcUrls } from '../checkout/senders/index.js';
import { env } from '../env.js';
import { hookChainSupported } from '../gas/fees.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

const hookDataRefused = (reason: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, 400, { field: 'hook_data', reason });

/** Whether `address` on `chain` holds contract code (live mode only). */
type CodeCheck = (chain: string, address: string) => Promise<boolean>;
const CODE_CACHE_MS = 10 * 60_000;
const RPC_TIMEOUT_MS = 5_000;
const codeCache = new Map<string, number>();

async function jsonRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(JSON.stringify(body.error).slice(0, 200));
  return body.result;
}

/** An account without a contract has this code hash on NEAR. */
const NEAR_NO_CODE = '11111111111111111111111111111111';

const liveCodeCheck: CodeCheck = async (chain, address) => {
  if (chain === 'near') {
    const r = (await jsonRpc(env().NEAR_RPC_URL_LIVE, 'query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: address,
    })) as { code_hash?: string } | null;
    return typeof r?.code_hash === 'string' && r.code_hash !== NEAR_NO_CODE;
  }
  const url = evmRpcUrls()[chain];
  if (!url) throw new Error(`no RPC for ${chain}`);
  const code = await jsonRpc(url, 'eth_getCode', [address, 'latest']);
  return typeof code === 'string' && code !== '0x' && code !== '0x0';
};
let codeCheck: CodeCheck = liveCodeCheck;

/** Tests: replace the live code check (`null` restores it) and forget cached answers. */
export function setHookCodeCheck(fn: CodeCheck | null): void {
  codeCheck = fn ?? liveCodeCheck;
  codeCache.clear();
}

/**
 * Throws unless `address` on `chain` is a contract. Test mode settles nowhere real: no check.
 * PROVIDER_UNAVAILABLE (503) when the chain cannot be asked. A positive answer is cached.
 */
export async function assertHookDestination(
  chain: string,
  address: string,
  livemode: boolean,
): Promise<void> {
  if (!livemode) return;
  const key = `${chain}:${address.toLowerCase()}`;
  const hit = codeCache.get(key);
  if (hit && Date.now() - hit < CODE_CACHE_MS) return;
  let isContract: boolean;
  try {
    isContract = await codeCheck(chain, address);
  } catch (err) {
    log('warn', 'hook destination check unavailable', { chain, err: String(err) });
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'Could not confirm the settlement contract; try again',
      503,
    );
  }
  if (!isContract) {
    throw hookDataRefused(
      'destination_not_contract',
      'hook_data needs the settlement destination to be a contract',
    );
  }
  codeCache.set(key, Date.now());
}

/**
 * The delivery of a new session: HOOK with its `hook_data` when given (and allowed), else WEBHOOK.
 * VALIDATION_ERROR (400, `field: hook_data`) when the store may not use hooks there.
 */
export async function hookDeliveryFor(p: {
  livemode: boolean;
  merchantKind: 'merchant' | 'integrator';
  payoutMode: string;
  chain: string;
  recipient: string;
  hookData: unknown;
}): Promise<{ delivery: 'WEBHOOK' | 'HOOK'; hookData: Prisma.InputJsonValue | null }> {
  if (p.hookData === undefined) return { delivery: 'WEBHOOK', hookData: null };
  if (p.merchantKind !== 'integrator') {
    throw hookDataRefused('not_integrator', 'hook_data is only for integrator stores');
  }
  if (p.payoutMode !== 'wallet') {
    throw hookDataRefused(
      'destination_not_contract',
      'hook_data needs the store to settle into its own contract (wallet payout)',
    );
  }
  if (!hookChainSupported(p.chain)) {
    throw hookDataRefused(
      'chain_unsupported',
      `Integrator hooks are not available on ${p.chain} (NEAR and EVM chains only)`,
    );
  }
  await assertHookDestination(p.chain, p.recipient, p.livemode);
  return { delivery: 'HOOK', hookData: p.hookData as Prisma.InputJsonValue };
}
