import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, type StoreContext } from './api';
import { withStepUp } from './webauthn';

export interface NativePayout {
  id: string;
  status: string;
  asset: string;
  amount: string;
  destinationAsset: string;
  destinationChain: string;
  destination: string;
  proposalId: string | null;
  invoiceId?: string | null;
  expiresAt: string;
  intentHash: string | null;
  quote: { quote: { amountOut: string; minAmountOut?: string } };
}
export interface NativeChallenge {
  options: PublicKeyCredentialRequestOptionsJSON;
  payload: string;
}
const base = '/v1/account/native';

export async function registerWallet(store: StoreContext): Promise<void> {
  const optionsJSON = await withStepUp(() =>
    api<PublicKeyCredentialCreationOptionsJSON>(`${base}/passkey/options`, {
      method: 'POST',
      json: {},
      store,
    }),
  );
  const response = await startRegistration({ optionsJSON });
  await withStepUp(() =>
    api(`${base}/passkey/verify`, { method: 'POST', json: { response }, store }),
  );
}
export async function activateWallet(store: StoreContext): Promise<void> {
  const challenge = await withStepUp(() =>
    api<NativeChallenge>(`${base}/activate/options`, { method: 'POST', json: {}, store }),
  );
  const response = await startAuthentication({ optionsJSON: challenge.options });
  await withStepUp(() => api(`${base}/activate`, { method: 'POST', json: { response }, store }));
}
export async function signPayout(
  store: StoreContext,
  reviewed: NativePayout,
): Promise<NativePayout> {
  const path = `${base}/payouts/${encodeURIComponent(reviewed.id)}`;
  const challenge = await withStepUp(() =>
    api<NativePayout & NativeChallenge>(`${path}/challenge`, { method: 'POST', json: {}, store }),
  );
  for (const key of [
    'id',
    'asset',
    'amount',
    'destination',
    'destinationAsset',
    'destinationChain',
    'invoiceId',
  ] as const)
    if (challenge[key] !== reviewed[key])
      throw new Error('The payout changed. Reload and review it before signing.');
  const response = await startAuthentication({ optionsJSON: challenge.options });
  return withStepUp(() =>
    api<NativePayout>(`${path}/submit`, { method: 'POST', json: { response }, store }),
  );
}
