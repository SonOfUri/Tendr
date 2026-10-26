'use client';

import type { Quote, Token } from '@/lib/checkout/api';

/**
 * The connect-wallet slot. Task 12 fills it in (Reown AppKit for EVM, Solana and Bitcoin,
 * TronLink, NEAR Wallet Selector): connect, then send exactly `quote.amount_in` of `token` from
 * the shopper's own wallet to `quote.deposit_address`. Tendr never signs for the shopper.
 */
export interface WalletConnectProps {
  /** The live quote: where to send, how much (base units) and until when. */
  quote: Pick<Quote, 'id' | 'deposit_address' | 'amount_in' | 'origin_asset' | 'deadline'>;
  /** The token being paid with (network, decimals, symbol). */
  token: Token;
  /**
   * The connected wallet's address on the token's network. The page re-quotes with it as the
   * return address, so money that needs to come back goes straight to that wallet.
   */
  onWalletAddress?: (address: string) => void;
  /** The deposit transaction was sent: the page reports it so the payment is seen sooner. */
  onDepositSent?: (txHash: string) => void;
}

/** Not available yet: a disabled "Connect wallet" button. The manual send below is complete. */
export function WalletConnect(_props: WalletConnectProps) {
  return (
    <div className="pay-wallet">
      <button type="button" className="pay-button" disabled aria-describedby="pay-wallet-hint">
        Connect wallet
      </button>
      <p id="pay-wallet-hint" className="muted small">
        Coming soon. For now, send from your wallet using the details below.
      </p>
    </div>
  );
}
