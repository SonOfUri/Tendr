// Bitcoin deposits through AppKit's Bitcoin adapter: the wallet's own send (`sendTransfer`, i.e.
// sendBitcoin) of the exact satoshis to the deposit address. Wallets that only sign PSBTs refuse
// it; the shopper is then told to send manually. Mainnet only.
import { WalletError, toWalletError } from './errors';
import type { PayTarget, WalletAdapter } from './index';
import { assertDepositMatches } from './match';
import type { AppKitSession } from './appkit';

export interface BitcoinProviderLike {
  sendTransfer(p: { recipient: string; amount: string }): Promise<string>;
}

const TXID = /^[0-9a-fA-F]{64}$/;
/** Mainnet address forms: bech32 / bech32m (bc1…) and legacy base58 (1… / 3…). */
const MAINNET_ADDRESS =
  /^(bc1[02-9ac-hj-np-z]{11,71}|BC1[02-9AC-HJ-NP-Z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;

export function createBitcoinAdapter(
  target: PayTarget,
  deps: { session: AppKitSession<BitcoinProviderLike> },
): WalletAdapter {
  if (target.family !== 'bitcoin') throw new WalletError('failed', { detail: 'not Bitcoin' });
  let address: string | null = null;
  return {
    chainFamily: 'bitcoin',
    async connect() {
      try {
        address = (await deps.session.connect()).address;
        return { address };
      } catch (err) {
        throw toWalletError(err);
      }
    },
    async sendDeposit(q) {
      const provider = deps.session.provider();
      if (!address || !provider) throw new WalletError('failed', { detail: 'not connected' });
      const amount = assertDepositMatches(target, q);
      if (!MAINNET_ADDRESS.test(address) || !(await deps.session.ensureNetwork())) {
        throw new WalletError('chain_mismatch', { network: 'Bitcoin' });
      }
      let txid: unknown;
      try {
        txid = await provider.sendTransfer({
          recipient: q.depositAddress,
          amount: amount.toString(),
        });
      } catch (err) {
        throw toWalletError(err);
      }
      if (typeof txid !== 'string' || !TXID.test(txid)) {
        throw new WalletError('uncertain', { detail: 'no transaction id' });
      }
      return { txHash: txid };
    },
    async disconnect() {
      address = null;
      await deps.session.disconnect();
    },
  };
}
