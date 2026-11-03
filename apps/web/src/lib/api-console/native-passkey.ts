import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

type Step =
  | { kind: 'register'; target: string; options: PublicKeyCredentialCreationOptionsJSON }
  | { kind: 'authenticate'; target: string; options: PublicKeyCredentialRequestOptionsJSON };
export function nativePasskeyStep(path: string, data: unknown): Step | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as Record<string, unknown>;
  if (path === '/v1/account/native/passkey/options' && typeof body.challenge === 'string')
    return {
      kind: 'register',
      target: '/v1/account/native/passkey/verify',
      options: body as unknown as PublicKeyCredentialCreationOptionsJSON,
    };
  const options = body.options as PublicKeyCredentialRequestOptionsJSON | undefined;
  if (!options || typeof options.challenge !== 'string' || !Array.isArray(options.allowCredentials))
    return null;
  if (
    path === '/v1/account/native/passkey/verify' ||
    path === '/v1/account/native/activate/options'
  )
    return { kind: 'authenticate', target: '/v1/account/native/activate', options };
  if (/^\/v1\/account\/native\/payouts\/[^/]+\/challenge$/.test(path))
    return { kind: 'authenticate', target: path.replace(/\/challenge$/, '/submit'), options };
  return null;
}
