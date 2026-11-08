// Live native-wallet ceremonies. The login passkey and the wallet passkey are different
// credentials. Routes marked step-up use the session passkey; activate and submit use the wallet.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
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
  expiresAt: string;
  intentHash: string | null;
  quote: { quote: { amountOut: string; minAmountOut?: string } };
}

export async function registerWallet(store: StoreContext) {
  const options = await withStepUp(() =>
    api<PublicKeyCredentialCreationOptionsJSON>('/v1/account/native/passkey/options', {
      method: 'POST',
      json: {},
      store,
    }),
  );
  const credential: RegistrationResponseJSON = await startRegistration({ optionsJSON: options });
  await api('/v1/account/native/passkey/verify', {
    method: 'POST',
    json: { response: credential },
    store,
  });
}

type ActivationChallenge = {
  options: PublicKeyCredentialRequestOptionsJSON;
};

export async function activateWallet(store: StoreContext) {
  // POST /activate/options returns account metadata plus nested WebAuthn `options`
  // (same shape as register/verify). Passing the whole body to startAuthentication
  // leaves challenge undefined → "Cannot read properties of undefined (reading 'replace')".
  const { options } = await withStepUp(() =>
    api<ActivationChallenge>('/v1/account/native/activate/options', {
      method: 'POST',
      json: {},
      store,
    }),
  );
  if (!options?.challenge) {
    throw new Error('Wallet activation challenge was incomplete. Try again.');
  }
  const credential: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: options,
  });
  await api('/v1/account/native/activate', {
    method: 'POST',
    json: { response: credential },
    store,
  });
}

type Challenge = NativePayout & { options: PublicKeyCredentialRequestOptionsJSON };

/** Signs one reviewed payout. The challenge must still describe that same payout. */
export async function signPayout(store: StoreContext, payout: NativePayout): Promise<NativePayout> {
  const challenge = await withStepUp(() =>
    api<Challenge>(`/v1/account/native/payouts/${encodeURIComponent(payout.id)}/challenge`, {
      method: 'POST',
      json: {},
      store,
    }),
  );
  const same =
    challenge.id === payout.id &&
    challenge.asset === payout.asset &&
    challenge.amount === payout.amount &&
    challenge.destination === payout.destination &&
    challenge.destinationAsset === payout.destinationAsset &&
    challenge.destinationChain === payout.destinationChain;
  if (!same) {
    throw new Error('The payout changed after review. Review the new quote before signing.');
  }
  const credential = await startAuthentication({ optionsJSON: challenge.options });
  return api<NativePayout>(`/v1/account/native/payouts/${encodeURIComponent(payout.id)}/submit`, {
    method: 'POST',
    json: { response: credential },
    store,
  });
}
