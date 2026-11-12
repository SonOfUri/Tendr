// Choosing where a store's payments settle (WooCommerce plugin spec §2 "choose payout"): in the
// Connect popup and on the dashboard's Payout page. The API reports the mode's payout and the
// tokens offered (`GET /v1/account/settlement`, USDC first); choosing one drafts the existing
// `set_settlement` proposal (intents settlement into the store's own account), which the store's
// signers approve with their passkeys like any other change.
import type { ProposalStatus } from './api';

export interface SettlementChoice {
  asset: string;
  symbol: string;
  chain: string;
  default: boolean;
}

export interface SettlementView {
  livemode: boolean;
  account_kind?: 'contract' | 'native_intents' | null;
  /** The mode's merchant account status, or null when it has none yet. */
  account_status: string | null;
  settlement: { asset: string; symbol: string | null; chain: string; payout_mode: string } | null;
  /** An open `set_settlement` proposal. */
  pending: { id: string; status: ProposalStatus } | null;
  choices: SettlementChoice[];
}

export type PayoutStep =
  'set' | 'waiting' | 'not-live' | 'account-pending' | 'account-failed' | 'choose';

/** What to show for a store's payout. */
export function payoutStep(v: SettlementView): PayoutStep {
  if (v.settlement) return 'set';
  if (v.pending) return 'waiting';
  if (v.account_status === 'failed') return 'account-failed';
  // C14: live mode before going live has no account at all; nothing is being created.
  if (v.account_status === null && v.livemode) return 'not-live';
  if (v.account_status !== 'active') return 'account-pending';
  return 'choose';
}

/** The preselected token: USDC. */
export function defaultChoice(v: SettlementView): SettlementChoice | null {
  return v.choices.find((c) => c.default) ?? v.choices[0] ?? null;
}

/** The `set_settlement` action for `asset`: intents settlement into the store's account. */
export function settlementAction(asset: string) {
  return { set_settlement: { dest_asset: asset, payout_mode: 'intents', saved_address_id: null } };
}

/** After this person's passkey approval: set, still waiting for the other signers, or failed. */
export function afterApproval(status: ProposalStatus): 'done' | 'needs-signers' | 'failed' {
  if (status === 'executed' || status === 'executing') return 'done';
  if (status === 'pending' || status === 'timelocked' || status === 'draft') return 'needs-signers';
  return 'failed';
}

/** A `set_settlement` draft this screen made and has not approved yet (its passkey prompt failed). */
export interface OwnDraft {
  id: string;
  asset: string;
}

/**
 * What "Approve payout" does (C14): approve the draft an earlier, failed attempt left for the
 * same token; replace it (drop the draft, draft anew) for another token; else draft one.
 */
export function payoutAttempt(
  own: OwnDraft | null,
  asset: string,
): { k: 'draft' } | { k: 'reuse'; id: string } | { k: 'replace'; cancel: string } {
  if (!own) return { k: 'draft' };
  return own.asset === asset ? { k: 'reuse', id: own.id } : { k: 'replace', cancel: own.id };
}
