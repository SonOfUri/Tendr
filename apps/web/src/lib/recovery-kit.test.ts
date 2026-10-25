import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import {
  confirmationCharacters,
  createRecoveryKit,
  formatRecoveryKit,
  matchesConfirmation,
  parseRecoveryKit,
  publicKeyFromKit,
  signRecovery,
} from './recovery-kit';

const vectors = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../onchain/merchant-account/test-vectors/recovery-payloads.json'),
    'utf8',
  ),
) as {
  recovery_public_key_b64: string;
  message_hex: string;
  signature_b64: string;
};

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
/** The vectors' test kit key: Ed25519 seed [9; 32]. */
const VECTOR_SEED = new Uint8Array(32).fill(9);

describe('recovery kit', () => {
  it('recovery_kit_roundtrip', () => {
    const kit = createRecoveryKit();
    // 32 bytes → 52 base32 characters in 13 groups of 4, plus one checksum group.
    const groups = kit.secretWords.split('-');
    expect(groups).toHaveLength(14);
    for (const g of groups) expect(g).toMatch(/^[A-Z2-7]{4}$/);

    const secret = parseRecoveryKit(kit.secretWords);
    expect(secret).toHaveLength(32);
    const pub = ed25519.getPublicKey(secret);
    expect(Buffer.from(pub).toString('base64')).toBe(kit.publicKeyB64);
    expect(publicKeyFromKit(kit.secretWords)).toBe(kit.publicKeyB64);
    // Tolerant of case, spaces and missing dashes when typed back.
    expect(parseRecoveryKit(kit.secretWords.toLowerCase().replaceAll('-', ' '))).toEqual(secret);

    // A single typo is caught by the checksum.
    const chars = kit.secretWords.split('');
    chars[6] = chars[6] === 'A' ? 'B' : 'A';
    expect(() => parseRecoveryKit(chars.join(''))).toThrow(/check/i);
    // So is a truncated kit.
    expect(() => parseRecoveryKit(kit.secretWords.slice(0, 20))).toThrow();

    // Two kits differ.
    expect(createRecoveryKit().secretWords).not.toBe(kit.secretWords);
  });

  it('formats the vector seed and confirms characters 5-8', () => {
    const text = formatRecoveryKit(VECTOR_SEED);
    expect(publicKeyFromKit(text)).toBe(vectors.recovery_public_key_b64);
    const conf = confirmationCharacters(text);
    expect(conf).toBe(text.replaceAll('-', '').slice(4, 8));
    expect(matchesConfirmation(text, conf.toLowerCase())).toBe(true);
    expect(matchesConfirmation(text, ` ${conf} `)).toBe(true);
    expect(matchesConfirmation(text, 'ZZZ')).toBe(false);
    expect(matchesConfirmation(text, '')).toBe(false);
  });

  it('signRecovery_verifies_with_noble', () => {
    const kit = createRecoveryKit();
    const message = hex(vectors.message_hex);
    const sig = signRecovery(kit.secretWords, message);
    expect(fromB64(sig)).toHaveLength(64);
    expect(ed25519.verify(fromB64(sig), message, fromB64(kit.publicKeyB64))).toBe(true);
    expect(ed25519.verify(fromB64(sig), new Uint8Array(32), fromB64(kit.publicKeyB64))).toBe(false);

    // Against the shared contract vector (deterministic Ed25519): same bytes as the Rust side.
    expect(signRecovery(VECTOR_SEED, message)).toBe(vectors.signature_b64);
    expect(signRecovery(formatRecoveryKit(VECTOR_SEED), message)).toBe(vectors.signature_b64);
  });
});
