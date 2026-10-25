// Estimated USD cost of the shopper's origin-chain send, per chain family. Used for the merchant's
// gas reimbursement (capped by `gas_max_usd`, see pricing.ts).
//
// PLACEHOLDER: a static table until project 5's gas service gives live estimates. Values are
// deliberately rough upper-middle figures for a single token transfer. Unknown families get 0
// (no reimbursement) rather than a guess.
import { chainFamily, type ChainFamily } from './address-format.js';

export const GAS_ESTIMATE_USD: Readonly<Record<ChainFamily, string>> = {
  evm: '0.5',
  solana: '0.01',
  tron: '1',
  near: '0.01',
  bitcoin: '2',
  other: '0',
};

/** Estimated send fee (USD decimal string) for a 1Click `blockchain` id. */
export function gasEstimateUsd(blockchain: string): string {
  return GAS_ESTIMATE_USD[chainFamily(blockchain)];
}
