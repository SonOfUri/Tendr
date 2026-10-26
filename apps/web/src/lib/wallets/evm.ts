// EVM deposits through the connected wallet's EIP-1193 provider (AppKit: injected wallets and
// WalletConnect). The native coin is a plain value transfer; an ERC-20 is `transfer(to, amount)`
// on the token contract with value 0. Before sending, the wallet must be on the quote's chain: we
// ask it to switch, and if it does not, the send is blocked.
import { networkName } from '@/lib/checkout/format';
import { toHexQuantity } from './amount';
import { WalletError, toWalletError } from './errors';
import type { DepositRequest, PayTarget, WalletAdapter } from './index';
import { assertDepositMatches } from './match';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export interface EvmSession {
  connect(): Promise<{ address: string }>;
  provider(): Eip1193 | undefined;
  disconnect(): Promise<void>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** keccak256("transfer(address,uint256)")[0..4]. */
const TRANSFER_SELECTOR = 'a9059cbb';
const UINT256_MAX = (1n << 256n) - 1n;

/** ABI-encodes `transfer(to, amount)`. */
export function encodeErc20Transfer(to: string, amount: bigint): string {
  if (!ADDRESS.test(to)) throw new WalletError('failed', { detail: 'bad recipient' });
  if (amount <= 0n || amount > UINT256_MAX)
    throw new WalletError('failed', { detail: 'bad amount' });
  return (
    '0x' +
    TRANSFER_SELECTOR +
    to.slice(2).toLowerCase().padStart(64, '0') +
    amount.toString(16).padStart(64, '0')
  );
}

export interface EvmTx {
  from: string;
  to: string;
  value: string;
  data?: string;
}

/** The transaction that pays `q` from `from`. */
export function buildEvmDeposit(target: PayTarget, q: DepositRequest, from: string): EvmTx {
  const amount = assertDepositMatches(target, q);
  if (target.kind === 'native') return { from, to: q.depositAddress, value: toHexQuantity(amount) };
  if (!target.contract || !ADDRESS.test(target.contract)) {
    throw new WalletError('failed', { detail: 'no token contract' });
  }
  return {
    from,
    to: target.contract,
    value: '0x0',
    data: encodeErc20Transfer(q.depositAddress, amount),
  };
}

async function chainIdOf(provider: Eip1193): Promise<number | null> {
  const raw = await provider.request({ method: 'eth_chainId' });
  if (typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
  if (typeof raw === 'number') return raw;
  return null;
}

/** Puts the wallet on `chainId`, or throws chain_mismatch. */
export async function ensureEvmChain(provider: Eip1193, chainId: number, network: string) {
  if ((await chainIdOf(provider)) === chainId) return;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + chainId.toString(16) }],
    });
  } catch {
    throw new WalletError('chain_mismatch', { network });
  }
  if ((await chainIdOf(provider)) !== chainId) throw new WalletError('chain_mismatch', { network });
}

export function createEvmAdapter(target: PayTarget, session: EvmSession): WalletAdapter {
  if (target.family !== 'evm' || target.chainId === undefined) {
    throw new WalletError('failed', { detail: 'not an EVM asset' });
  }
  const chainId = target.chainId;
  const network = networkName(target.blockchain);
  let address: string | null = null;

  return {
    chainFamily: 'evm',
    async connect() {
      try {
        const r = await session.connect();
        if (!ADDRESS.test(r.address)) throw new WalletError('failed', { detail: 'bad account' });
        address = r.address;
        return { address, chainId: String(chainId) };
      } catch (err) {
        throw toWalletError(err);
      }
    },
    async sendDeposit(q) {
      const provider = session.provider();
      if (!address || !provider) throw new WalletError('failed', { detail: 'not connected' });
      // Checked before the wallet is touched: never a different asset or amount.
      const tx = buildEvmDeposit(target, q, address);
      await ensureEvmChain(provider, chainId, network);
      let hash: unknown;
      try {
        hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
      } catch (err) {
        throw toWalletError(err);
      }
      if (typeof hash !== 'string' || !TX_HASH.test(hash)) {
        throw new WalletError('failed', { detail: 'no transaction hash' });
      }
      return { txHash: hash };
    },
    async disconnect() {
      address = null;
      await session.disconnect();
    },
  };
}
