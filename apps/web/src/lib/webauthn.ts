// Passkey ceremonies for the dashboard: register, sign in, step-up, and signing a server challenge
// (approvals and recovery cancels). Every ceremony requires user verification (Face ID, Touch ID,
// Windows Hello, or the device PIN).
import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialDescriptorJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, ApiError, type Passkey } from './api';
import { publicEnv } from './env';

export interface SessionStart {
  user: { id: string; email: string; emailVerifiedAt: string | null };
  hasPasskey: boolean;
}

/** Registers a passkey for the signed-in person. The first one needs no step-up; later ones do. */
export async function registerPasskey(
  opts: { deviceLabel?: string; recoveryToken?: string } = {},
): Promise<Passkey> {
  const extra = opts.recoveryToken ? { recoveryToken: opts.recoveryToken } : {};
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(
    '/v1/auth/passkeys/register/options',
    { method: 'POST', json: extra, store: false },
  );
  const response = await startRegistration({ optionsJSON });
  const { credential } = await api<{ credential: Passkey }>('/v1/auth/passkeys/register/verify', {
    method: 'POST',
    json: { response, ...(opts.deviceLabel ? { deviceLabel: opts.deviceLabel } : {}), ...extra },
    store: false,
  });
  return credential;
}

/** Signs in with any passkey on this device (discoverable; no email asked). */
export async function loginWithPasskey(): Promise<SessionStart> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(
    '/v1/auth/passkeys/login/options',
    { method: 'POST', json: {}, store: false },
  );
  const response = await startAuthentication({ optionsJSON });
  return api<SessionStart>('/v1/auth/passkeys/login/verify', {
    method: 'POST',
    json: { response },
    store: false,
  });
}

/** Re-proves a passkey on this session (sensitive actions need one in the last 10 minutes). */
export async function stepUp(): Promise<void> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(
    '/v1/auth/passkeys/step-up/options',
    { method: 'POST', json: {}, store: false },
  );
  const response = await startAuthentication({ optionsJSON });
  await api('/v1/auth/passkeys/step-up/verify', {
    method: 'POST',
    json: { response },
    store: false,
  });
}

/** Runs `fn`; on `STEP_UP_REQUIRED` runs a step-up ceremony and retries once. */
export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'STEP_UP_REQUIRED') throw err;
    await stepUp();
    return fn();
  }
}

/**
 * Signs a server-issued challenge (base64url) with one of `allowCredentials`. The challenge comes
 * from the API (approvals, recovery cancel); the contract checks the RP ID hash and the challenge.
 */
export async function signChallenge(
  challengeB64u: string,
  allowCredentials: PublicKeyCredentialDescriptorJSON[],
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({
    optionsJSON: {
      challenge: challengeB64u,
      allowCredentials,
      userVerification: 'required',
      timeout: 120_000,
      ...(publicEnv.webauthnRpId ? { rpId: publicEnv.webauthnRpId } : {}),
    },
  });
}
