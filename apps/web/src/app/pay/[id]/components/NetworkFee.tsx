'use client';

import type { NetworkFee as NetworkFeeView } from '@/lib/checkout/api';
import { formatUnits } from '@/lib/checkout/format';
import {
  feeChoiceAvailable,
  gaslessMethodOf,
  type FeeMode,
  type GaslessOption,
} from '@/lib/wallets/gasless/index';

// The wallet path's network-fee line (spec §2.1, Global Constraints copy, exactly):
// - merchant sponsors → "Network fee: paid by {merchant name}" (no choice to make);
// - shopper pays, both ways possible → "Pay the fee in {token}" ("+{amount} {symbol}") /
//   "Pay the fee in {coin}";
// - shopper pays in the token, no choice → "Network fee: +{amount} {symbol}" (§8.2);
// - no gasless method → "You'll need {coin} for the network fee".
// The shopper never reads why a payment isn't sponsored (budget, caps): only the outcome.

export const COPY_ADDRESS_FEE_NOTE = 'You pay the network fee from your wallet';

/** The choice appears only when the shopper pays and both the token and the coin are possible. */
export function showFeeChoice(
  option: GaslessOption | null,
  networkFee: NetworkFeeView | null | undefined,
): boolean {
  return feeChoiceAvailable(option) && networkFee?.paid_by === 'shopper';
}

export function NetworkFee({
  networkFee,
  merchantName,
  token,
  coin,
  choice,
  disabled = false,
}: {
  /** The quote's `network_fee`. */
  networkFee: NetworkFeeView | null | undefined;
  merchantName: string;
  token: { symbol: string; decimals: number };
  /** The chain's coin ("ETH"), or null when unknown. */
  coin: string | null;
  /** Shown only when `showFeeChoice`: the selected way, and the token fee (base units). */
  choice: { mode: FeeMode; tokenFeeAmount: string | null; onChoose: (m: FeeMode) => void } | null;
  disabled?: boolean;
}) {
  const coinName = coin ?? 'the network’s coin';
  const tokenFee = (amount: string | null | undefined) => {
    const f = amount ? formatUnits(amount, token.decimals) : null;
    return f ? `+${f} ${token.symbol}` : null;
  };

  if (choice) {
    const plus = tokenFee(
      networkFee?.fee_mode === 'token' ? networkFee.amount : choice.tokenFeeAmount,
    );
    return (
      <fieldset className="pay-fee-choice" disabled={disabled}>
        <legend className="small">Network fee</legend>
        <label>
          <input
            type="radio"
            name="network-fee"
            value="token"
            checked={choice.mode === 'token'}
            onChange={() => choice.onChoose('token')}
          />{' '}
          Pay the fee in {token.symbol}
          {plus ? <span className="muted"> ({plus})</span> : null}
        </label>
        <label>
          <input
            type="radio"
            name="network-fee"
            value="native"
            checked={choice.mode === 'native'}
            onChange={() => choice.onChoose('native')}
          />{' '}
          Pay the fee in {coinName}
        </label>
      </fieldset>
    );
  }

  const gasless = gaslessMethodOf({ network_fee: networkFee }) !== null;
  if (gasless && networkFee?.paid_by === 'merchant') {
    return <p className="small">Network fee: paid by {merchantName}</p>;
  }
  if (gasless && networkFee?.fee_mode === 'token') {
    const plus = tokenFee(networkFee.amount);
    if (plus) return <p className="small">Network fee: {plus}</p>;
  }
  return <p className="small">You&apos;ll need {coinName} for the network fee</p>;
}
