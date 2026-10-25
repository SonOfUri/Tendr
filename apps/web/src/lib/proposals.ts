// Approving and cancelling proposals with a passkey: ask the API for the challenge (the approval
// payload hash the contract checks), sign it on this device, post the assertion back.
import { api, type Proposal, type SignerChallenge } from './api';
import { signChallenge } from './webauthn';

/** Approves `id` with one of the signer's passkeys. The first approval puts it on chain. */
export async function approveProposal(id: string): Promise<Proposal> {
  const ch = await api<SignerChallenge>(`/v1/account/proposals/${id}/challenge`, {
    method: 'POST',
    json: { intent: 'approve' },
  });
  const response = await signChallenge(ch.challengeB64u, ch.allowCredentials);
  return api<Proposal>(`/v1/account/proposals/${id}/approve`, {
    method: 'POST',
    json: { response },
  });
}

/**
 * Cancels `p`. A draft is dropped without a passkey (its requester or any signer); a pending or
 * timelocked proposal needs a signer's passkey over a `cancel` challenge.
 */
export async function cancelProposal(p: Pick<Proposal, 'id' | 'status'>): Promise<Proposal> {
  if (p.status === 'draft') {
    return api<Proposal>(`/v1/account/proposals/${p.id}/cancel`, { method: 'POST', json: {} });
  }
  const ch = await api<SignerChallenge>(`/v1/account/proposals/${p.id}/challenge`, {
    method: 'POST',
    json: { intent: 'cancel' },
  });
  const response = await signChallenge(ch.challengeB64u, ch.allowCredentials);
  return api<Proposal>(`/v1/account/proposals/${p.id}/cancel`, {
    method: 'POST',
    json: { response },
  });
}

/** Creates a draft; the API answers with the proposal (its id for the detail page). */
export function draftProposal(action: Record<string, unknown>): Promise<Proposal> {
  return api<Proposal>('/v1/account/proposals', { method: 'POST', json: { action } });
}

export const STATUS_WORDS: Record<string, string> = {
  draft: 'Waiting for a signer',
  pending: 'Pending approvals',
  timelocked: 'Waiting (timelock)',
  executing: 'Executing',
  executed: 'Done',
  cancelled: 'Cancelled',
  expired: 'Expired',
  failed: 'Failed',
};
