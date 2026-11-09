import { ulid } from 'ulid';

/** Resource id prefixes. Ids are `${prefix}_${ulid}`, so they sort by creation time. */
export type IdPrefix =
  | 'mer'
  | 'usr' // merchant membership (merchant_users)
  | 'key'
  | 'akey'
  | 'stc'
  | 'pal'
  | 'whe'
  | 'gpol'
  | 'gbm' // gas_budget_months
  | 'plink'
  | 'ses'
  | 'quo'
  | 'pay'
  | 'ref'
  | 'whd'
  | 'hook'
  | 'gas'
  | 'scr'
  | 'evt'
  | 'obx'
  | 'fplan'
  | 'rev'
  | 'scl' // settlement_claims
  | 'thm'
  | 'tasset'
  | 'pimg'
  | 'sec'
  | 'idem'
  | 'per' // person (users); also their signer id on account contracts
  | 'cred'
  | 'dss'
  | 'etok'
  | 'wch' // webauthn ceremony challenge
  | 'inv'
  | 'nwal'
  | 'npay'
  | 'bill'
  | 'macc'
  | 'prop'
  | 'appr'
  | 'rec'
  | 'alim' // account_limits (mirror of the contract's per-asset limits)
  | 'ntc' // event_notices (signer notice emails sent per event)
  | 'con' // connections (sites linked through Connect)
  | 'cac' // connect_auth_codes
  | 'rtx' // relayer_transactions (the relayer's own on-chain transactions)
  | 'tap' // tron_approvals (gasless Tron: the shopper's relayed approve)
  | 'tdl' // tron_delegations (gas-tron's just-in-time energy / bandwidth delegations)
  | 'fsw'; // fee_sweeps (gas-fee account sweeps into USDC on NEAR)

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
