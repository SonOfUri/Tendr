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
  | 'sec'
  | 'idem'
  | 'per' // person (users); also their signer id on account contracts
  | 'cred'
  | 'dss'
  | 'etok'
  | 'wch' // webauthn ceremony challenge
  | 'inv'
  | 'macc'
  | 'prop'
  | 'appr'
  | 'rec'
  | 'alim' // account_limits (mirror of the contract's per-asset limits)
  | 'ntc' // event_notices (signer notice emails sent per event)
  | 'con' // connections (sites linked through Connect)
  | 'cac'; // connect_auth_codes

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
