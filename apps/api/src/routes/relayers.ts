// `GET /v1/relayers` (ruling R13-b, spec §4.4): Tendr's published relayer addresses, so an
// integrator can restrict its `onTendrDeposit` / `on_tendr_deposit` receiver to the relayer that
// calls it. Public and read-only. Addresses only, derived from the key vault's PUBLIC keys
// (`relayer-evm`, `relayer-near`); nothing secret is read or returned.
//
// One entry per chain where integrator hooks are called (HOOK_GAS_UNITS): `relayer-evm` (one
// address on every EVM chain) and `relayer-near`'s implicit account. Tron and Solana never call
// integrator hooks, so they are not listed. The same keys serve test and live mode (test mode
// never sends anything).
import type { FastifyPluginAsync } from 'fastify';
import { HOOK_GAS_UNITS } from '../gas/fees.js';
import { evmAddress, getKeyVault } from '../keyvault/index.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { implicitAccountId } from '../near/tx.js';
import { EVM_CHAIN_IDS } from '../relayer/evm/tokens.js';

export interface RelayerView {
  chain: string;
  family: 'evm' | 'near';
  /** EVM chain id; null on NEAR. */
  chain_id: number | null;
  /** The address that calls the integrator hook (EVM 0x…, lower-case; NEAR implicit account). */
  address: string;
  /** The hook method this relayer calls on the session's settlement contract. */
  calls: 'onTendrDeposit' | 'on_tendr_deposit';
}

let cached: RelayerView[] | null = null;

/** Tests: forget the cached list. */
export function resetRelayerList(): void {
  cached = null;
}

/** The published relayers (from public keys only; cached per process). */
export async function relayerList(): Promise<RelayerView[]> {
  if (cached) return cached;
  const kv = getKeyVault();
  const evm = await kv.publicKey('relayer-evm');
  const near = await kv.publicKey('relayer-near');
  if (evm.curve !== 'secp256k1' || near.curve !== 'ed25519') {
    throw new Error('relayer keys have unexpected curves');
  }
  const evmAddr = evmAddress(evm.raw).toLowerCase();
  const nearAccount = implicitAccountId(near.raw);
  const out: RelayerView[] = [];
  for (const chain of Object.keys(HOOK_GAS_UNITS)) {
    const chainId = EVM_CHAIN_IDS[chain];
    if (chainId !== undefined) {
      out.push({
        chain,
        family: 'evm',
        chain_id: chainId,
        address: evmAddr,
        calls: 'onTendrDeposit',
      });
    } else if (chain === 'near') {
      out.push({
        chain,
        family: 'near',
        chain_id: null,
        address: nearAccount,
        calls: 'on_tendr_deposit',
      });
    }
  }
  cached = out;
  return out;
}

export const relayerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/relayers', { config: { auth: 'public' } }, async () => {
    try {
      return { relayers: await relayerList() };
    } catch (err) {
      log('error', 'relayer list unavailable', { err: err instanceof Error ? err.name : 'error' });
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'Relayer addresses are unavailable; try again',
        503,
      );
    }
  });
};
