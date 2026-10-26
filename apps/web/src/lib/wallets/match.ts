// Checks shared by every adapter: a request must be exactly the quote the adapter was made for.
import { isValidAddress } from '@/lib/checkout/address';
import { parseBaseUnits } from './amount';
import { WalletError } from './errors';
import type { ChainFamily, DepositRequest, PayTarget } from './index';

/**
 * Checks a request against the target an adapter was made for, and returns the exact amount.
 * Never a different asset, a non-integer amount, or a deposit address in another chain's format.
 */
export function assertDepositMatches(target: PayTarget, q: DepositRequest): bigint {
  if (q.assetId !== target.assetId) {
    throw new WalletError('failed', { detail: 'the request is for a different asset' });
  }
  if (!Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 36) {
    throw new WalletError('failed', { detail: 'bad decimals' });
  }
  if (target.decimals !== undefined && q.decimals !== target.decimals) {
    throw new WalletError('failed', { detail: "decimals don't match the known token" });
  }
  if (
    typeof q.depositAddress !== 'string' ||
    !isValidAddress(target.blockchain, q.depositAddress)
  ) {
    throw new WalletError('failed', { detail: 'malformed deposit address' });
  }
  return parseBaseUnits(q.amount);
}

/** Two addresses are the same account (EVM addresses compare without case). */
export function sameAddress(
  family: ChainFamily,
  a: string | null | undefined,
  b: string | null | undefined,
) {
  if (!a || !b) return false;
  return family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
