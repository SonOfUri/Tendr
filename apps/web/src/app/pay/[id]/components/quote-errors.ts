import { CheckoutApiError } from '@/lib/checkout/api';

export type QuoteFailure =
  | { kind: 'expired' }
  | { kind: 'on_its_way' }
  | { kind: 'refund_address'; message: string }
  | { kind: 'message'; message: string; retry: boolean };

/** What to tell the shopper when getting a price failed. */
export function quoteFailure(err: unknown, symbol: string): QuoteFailure {
  if (!(err instanceof CheckoutApiError)) {
    return { kind: 'message', message: 'Something went wrong. Please try again.', retry: true };
  }
  const field = (err.details as { field?: string } | undefined)?.field;
  switch (err.code) {
    case 'SESSION_EXPIRED':
      return { kind: 'expired' };
    case 'DEPOSIT_IN_PROGRESS':
      return { kind: 'on_its_way' };
    case 'WALLET_NOT_ALLOWED':
      return {
        kind: 'refund_address',
        message:
          "This address can't be used for this payment. Use a different one, or leave it empty.",
      };
    case 'VALIDATION_ERROR':
      if (field === 'refund_address' || field === 'refund_chain') {
        return {
          kind: 'refund_address',
          message: "That address doesn't work for this token's network. Check it and try again.",
        };
      }
      return {
        kind: 'message',
        message: `We can't price ${symbol} right now. Choose another token.`,
        retry: false,
      };
    case 'QUOTE_PRICE_MOVED':
      return {
        kind: 'message',
        message: 'The price moved while we checked it. Please try again.',
        retry: true,
      };
    case 'QUOTE_TOO_SMALL':
      return {
        kind: 'message',
        message: `This order is too small to pay with ${symbol}. Choose another token.`,
        retry: false,
      };
    case 'UNSUPPORTED_ASSET':
      return {
        kind: 'message',
        message: `${symbol} can't be used here. Choose another token.`,
        retry: false,
      };
    case 'RATE_LIMITED':
      return {
        kind: 'message',
        message: 'Too many tries. Wait a minute, then try again.',
        retry: true,
      };
    case 'ACCOUNT_NOT_READY':
      return {
        kind: 'message',
        message: "The store can't take payments right now. Please contact the store.",
        retry: false,
      };
    case 'CONFLICT':
      return {
        kind: 'message',
        message: 'This checkout is no longer taking new payments.',
        retry: false,
      };
    case 'NETWORK_ERROR':
      return {
        kind: 'message',
        message: "We can't reach Tendr. Check your connection and try again.",
        retry: true,
      };
    default:
      return {
        kind: 'message',
        message: "We can't get a price right now. Try again in a moment.",
        retry: true,
      };
  }
}
