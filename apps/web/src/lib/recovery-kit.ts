// The recovery kit: an Ed25519 key made in the merchant's browser from 32 random bytes.
//
// The kit text is the 32-byte secret in base32 (RFC 4648 alphabet, no padding: 52 characters) in
// groups of 4, plus one checksum group (the first 4 base32 characters of sha256(secret)):
//
//   ABCD-EFGH-…-WXYZ-CHK1   (13 secret groups + 1 checksum group)
//
// The secret never leaves the browser: it is not sent to the API and is never written to
// localStorage, sessionStorage or IndexedDB. Only the public key (standard base64) is registered.
// Signing recovery payloads (`signRecovery`) is for the recovery screens.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import QRCode from 'qrcode';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_BYTES = 32;
const SECRET_CHARS = 52;
const GROUP = 4;

export interface RecoveryKit {
  /** The kit text to print or write down. Secret: keep it out of storage and logs. */
  secretWords: string;
  /** The kit's Ed25519 public key, 32 bytes in standard padded base64. */
  publicKeyB64: string;
}

export class RecoveryKitError extends Error {}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new RecoveryKitError('The recovery kit has a character that does not belong');
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const checksumOf = (secret: Uint8Array) => base32Encode(sha256(secret)).slice(0, GROUP);

/** Upper-case, without separators (spaces, dashes) — how a typed kit is compared. */
const normalize = (text: string) => text.toUpperCase().replace(/[\s-]+/g, '');

/** The kit text of a 32-byte secret. */
export function formatRecoveryKit(secret: Uint8Array): string {
  if (secret.length !== SECRET_BYTES) throw new RecoveryKitError('A recovery kit is 32 bytes');
  const chars = base32Encode(secret) + checksumOf(secret);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP) groups.push(chars.slice(i, i + GROUP));
  return groups.join('-');
}

/** The 32-byte secret of a kit text; throws when it is the wrong length or fails the checksum. */
export function parseRecoveryKit(text: string): Uint8Array {
  const chars = normalize(text);
  if (chars.length !== SECRET_CHARS + GROUP) {
    throw new RecoveryKitError('That recovery kit is the wrong length; check every group');
  }
  const secret = base32Decode(chars.slice(0, SECRET_CHARS));
  // 52 characters carry 260 bits: the last 4 must be zero for a canonical encoding.
  if (secret.length !== SECRET_BYTES || base32Encode(secret) !== chars.slice(0, SECRET_CHARS)) {
    throw new RecoveryKitError('That recovery kit does not check out; look for a typo');
  }
  if (checksumOf(secret) !== chars.slice(SECRET_CHARS)) {
    throw new RecoveryKitError('That recovery kit does not check out; look for a typo');
  }
  return secret;
}

/** A new kit from 32 bytes of `crypto.getRandomValues`. */
export function createRecoveryKit(): RecoveryKit {
  const secret = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(secret);
  const kit = {
    secretWords: formatRecoveryKit(secret),
    publicKeyB64: toBase64(ed25519.getPublicKey(secret)),
  };
  secret.fill(0);
  return kit;
}

/** The standard-base64 public key of a kit text. */
export function publicKeyFromKit(text: string): string {
  return toBase64(ed25519.getPublicKey(parseRecoveryKit(text)));
}

/** Characters 5–8 of the kit (its second group): what the merchant types back to confirm. */
export function confirmationCharacters(text: string): string {
  return normalize(text).slice(4, 8);
}

/** Whether `typed` is characters 5–8 of the kit (case and spaces ignored). */
export function matchesConfirmation(text: string, typed: string): boolean {
  const want = confirmationCharacters(text);
  return want.length === 4 && normalize(typed) === want;
}

/**
 * Signs `payloadBytes` exactly as given with the kit's Ed25519 key; returns the 64-byte signature
 * in standard padded base64. For a recovery, pass the 32-byte message
 * `sha256(borsh(RecoveryPayload))` (see apps/api/src/accounts/encoding.ts `recoveryMessage`);
 * for a recovery session, the server's challenge bytes.
 */
export function signRecovery(kitSecret: string | Uint8Array, payloadBytes: Uint8Array): string {
  const secret = typeof kitSecret === 'string' ? parseRecoveryKit(kitSecret) : kitSecret;
  if (secret.length !== SECRET_BYTES) throw new RecoveryKitError('A recovery kit is 32 bytes');
  return toBase64(ed25519.sign(payloadBytes, secret));
}

/** An SVG data URL of a QR code for `text` (rendered locally; no network). */
export async function qrDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Prints the kit. The page renders the kit sheet (`.print-kit`, text plus the QR from
 * `qrDataUrl(kit.secretWords)`); the print stylesheet hides everything else, so "Save as PDF" in
 * the print dialog gives a one-page kit. Nothing is uploaded.
 */
export function recoveryKitPdfOrPrint(kit: Pick<RecoveryKit, 'secretWords'>): void {
  if (!kit.secretWords || typeof window === 'undefined') return;
  window.print();
}
