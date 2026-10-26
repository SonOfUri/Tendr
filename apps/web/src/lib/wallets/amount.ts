// Amounts are the quote's base-unit strings, converted with BigInt only. Never floats.
import { WalletError } from './errors';

const BASE_UNITS = /^[1-9][0-9]{0,77}$/;

/** A quote's `amount_in` (base units, decimal string) as an exact positive bigint. */
export function parseBaseUnits(amount: string): bigint {
  if (typeof amount !== 'string' || !BASE_UNITS.test(amount)) {
    throw new WalletError('failed', { detail: 'amount is not a positive base-unit integer' });
  }
  return BigInt(amount);
}

/** A JSON-RPC hex quantity ("0x…", no leading zeros). */
export function toHexQuantity(value: bigint): string {
  if (value < 0n) throw new WalletError('failed', { detail: 'negative quantity' });
  return '0x' + value.toString(16);
}
