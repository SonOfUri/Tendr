// A software WebAuthn authenticator for tests: produces the JSON a browser hands to the server
// for `navigator.credentials.create()` / `.get()`, with `none` attestation. Test-only.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export type SoftAuthenticatorOptions = {
  alg?: 'ES256' | 'EdDSA';
  origin?: string;
  rpId?: string;
  /** Whether the authenticator reports user verification (default true). */
  userVerified?: boolean;
};

export class SoftAuthenticator {
  readonly alg: 'ES256' | 'EdDSA';
  credentialId: Buffer = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x?: string; y?: string };
  private counter = 0;
  origin: string;
  rpId: string;
  userVerified: boolean;

  constructor(opts: SoftAuthenticatorOptions = {}) {
    this.alg = opts.alg ?? 'ES256';
    this.origin = opts.origin ?? 'http://localhost:3000';
    this.rpId = opts.rpId ?? 'localhost';
    this.userVerified = opts.userVerified ?? true;
    const pair =
      this.alg === 'ES256'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicJwk = pair.publicKey.export({ format: 'jwk' });
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  /** Raw public key bytes: x‖y (P-256, 64 bytes) or the Ed25519 key (32 bytes). */
  get rawPublicKey(): { x: Buffer; y?: Buffer } {
    return {
      x: Buffer.from(this.publicJwk.x!, 'base64url'),
      y: this.publicJwk.y ? Buffer.from(this.publicJwk.y, 'base64url') : undefined,
    };
  }

  private cosePublicKey(): Uint8Array {
    const { x, y } = this.rawPublicKey;
    const map =
      this.alg === 'ES256'
        ? new Map<number, number | Uint8Array>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, x],
            [-3, y!],
          ])
        : new Map<number, number | Uint8Array>([
            [1, 1],
            [3, -8],
            [-1, 6],
            [-2, x],
          ]);
    return isoCBOR.encode(map);
  }

  private flags(extra = 0): number {
    return FLAG_UP | (this.userVerified ? FLAG_UV : 0) | extra;
  }

  private signCount(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(++this.counter);
    return b;
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  create(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(options.rp.id ?? this.rpId),
      Buffer.from([this.flags(FLAG_AT)]),
      this.signCount(),
      Buffer.alloc(16), // AAGUID
      credIdLen,
      this.credentialId,
      Buffer.from(this.cosePublicKey()),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** Signs any base64url challenge (a login challenge, or a proposal payload hash). */
  assert(challenge: string, opts: { origin?: string } = {}): AuthenticationResponseJSON {
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.flags()]),
      this.signCount(),
    ]);
    const clientDataJSON = this.clientData('webauthn.get', challenge, opts.origin);
    const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
    const signature =
      this.alg === 'ES256'
        ? sign('sha256', signed, this.privateKey) // DER
        : sign(null, signed, this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
    };
  }

  get(options: PublicKeyCredentialRequestOptionsJSON): AuthenticationResponseJSON {
    return this.assert(options.challenge);
  }
}
