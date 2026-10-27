// Which smart account sent a user operation, verified on chain against the known implementations
// (known-accounts.ts). Live mode only: test mode never calls an RPC.
import {
  COINBASE_CREATE_ACCOUNT_SELECTOR,
  COINBASE_SMART_WALLET_FACTORIES,
  COINBASE_SMART_WALLET_IMPLEMENTATIONS,
  ERC1967_IMPLEMENTATION_SLOT,
  SAFE_4337_MODULES,
  SAFE_IS_MODULE_ENABLED_SELECTOR,
  SAFE_PROXY_RUNTIME_PREFIX,
  SAFE_SINGLETONS,
  SOLADY_ERC1967_PROXY_RUNTIME,
} from './known-accounts.js';
import type { EvmRpc } from './rpc.js';
import { UserOpRefused, type AccountFormat, type UserOp } from './user-op.js';

/** How long an on-chain account lookup is reused (per chain + address). */
export const ACCOUNT_CACHE_MS = 60_000;

const cache = new Map<string, { format: AccountFormat; at: number }>();

/** Drops the account cache (tests). */
export function resetAccountCache(): void {
  cache.clear();
}

const addressFromWord = (word: string) => `0x${word.toLowerCase().replace(/^0x/, '').slice(-40)}`;

/** SafeProxy: the known functional runtime followed only by a solc CBOR metadata tail. */
function isSafeProxy(code: string): boolean {
  const c = code.toLowerCase();
  const prefix = SAFE_PROXY_RUNTIME_PREFIX.toLowerCase();
  if (!c.startsWith(prefix)) return false;
  return /^a2646970667358221220[0-9a-f]{64}64736f6c6343[0-9a-f]{6}0033$/.test(
    c.slice(prefix.length),
  );
}

/** The account format of deployed code, or null when it is not a known implementation. */
async function deployedFormat(
  rpc: EvmRpc,
  sender: string,
  code: string,
): Promise<AccountFormat | null> {
  if (code.toLowerCase() === SOLADY_ERC1967_PROXY_RUNTIME.toLowerCase()) {
    const impl = addressFromWord(
      String(
        await rpc.request('eth_getStorageAt', [sender, ERC1967_IMPLEMENTATION_SLOT, 'latest']),
      ),
    );
    return COINBASE_SMART_WALLET_IMPLEMENTATIONS.includes(impl) ? 'coinbase' : null;
  }
  if (isSafeProxy(code)) {
    const singleton = addressFromWord(
      String(await rpc.request('eth_getStorageAt', [sender, '0x0', 'latest'])),
    );
    if (!SAFE_SINGLETONS.includes(singleton)) return null;
    for (const module of SAFE_4337_MODULES) {
      const data = SAFE_IS_MODULE_ENABLED_SELECTOR + module.slice(2).padStart(64, '0');
      const res = String(await rpc.request('eth_call', [{ to: sender, data }, 'latest']));
      if (/^0x0*1$/.test(res)) return 'safe';
    }
    return null;
  }
  return null;
}

/**
 * Refuses (`UserOpRefused`) unless the operation's sender is a known smart-account implementation
 * whose call format is `format`: deployed code verified on chain, or (not yet deployed) a known
 * factory that only deploys a known implementation. RPC failures throw (the caller maps them to
 * "unavailable").
 */
export async function assertKnownAccount(
  rpc: EvmRpc,
  op: UserOp,
  format: AccountFormat,
  now: number = Date.now(),
): Promise<void> {
  const sender = op.sender.toLowerCase();
  const getCode = async () => {
    const code = String(await rpc.request('eth_getCode', [sender, 'latest']));
    return { code, deployed: code !== '0x' && code !== '0x0' && code !== '' };
  };
  if (op.factory) {
    // Counterfactual: the account is created by this operation.
    const { deployed } = await getCode();
    const factory = op.factory.toLowerCase();
    const known =
      !deployed &&
      COINBASE_SMART_WALLET_FACTORIES.includes(factory) &&
      (op.factoryData ?? '').toLowerCase().startsWith(COINBASE_CREATE_ACCOUNT_SELECTOR) &&
      format === 'coinbase';
    if (!known) throw new UserOpRefused('the account factory is not a known implementation');
    return;
  }
  const key = `${rpc.chain}:${sender}`;
  const hit = cache.get(key);
  let found: AccountFormat | null;
  if (hit && now - hit.at < ACCOUNT_CACHE_MS) {
    found = hit.format;
  } else {
    const { code, deployed } = await getCode();
    found = deployed ? await deployedFormat(rpc, sender, code) : null;
    // Only a verified account is reused: a refusal is looked up again next time.
    if (found) cache.set(key, { format: found, at: now });
  }
  if (found !== format) {
    throw new UserOpRefused('the sender is not a known smart-account implementation');
  }
}
