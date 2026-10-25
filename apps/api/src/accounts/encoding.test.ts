import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { p256 } from '@noble/curves/p256';
import { describe, expect, it } from 'vitest';
import {
  ActionSchema,
  approvalChallenge,
  approvalPayload,
  challengeB64u,
  encodeAction,
  encodeRecoveryPayload,
  kindOf,
  normalizeP256Signature,
  proposalId,
  recoveryId,
  recoveryMessage,
} from './encoding.js';

const VECTORS_DIR = fileURLToPath(
  new URL('../../../../onchain/merchant-account/test-vectors/', import.meta.url),
);
const readJson = (name: string) => JSON.parse(readFileSync(VECTORS_DIR + name, 'utf8'));

type ApprovalVector = {
  intent: 'approve' | 'cancel';
  payload_borsh_hex: string;
  challenge_hex: string;
  challenge_b64url: string;
};
type CaseVector = {
  name: string;
  action: unknown;
  action_borsh_hex: string;
  proposal_id_hex: string;
  approvals: ApprovalVector[];
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('approval encoding', () => {
  const v = readJson('approval-payloads.json');
  const salt = new Uint8Array(Buffer.from(v.salt_b64, 'base64'));
  const epoch = BigInt(v.signer_epoch);

  it('encoding_matches_rust_vectors', () => {
    expect(v.cases.length).toBeGreaterThan(0);
    for (const c of v.cases as CaseVector[]) {
      const action = ActionSchema.parse(c.action);
      expect(kindOf(action)).toBe(c.name);
      expect(hex(encodeAction(action)), c.name).toBe(c.action_borsh_hex);
      expect(proposalId(action, salt), c.name).toBe(c.proposal_id_hex);
      for (const a of c.approvals) {
        const input = {
          contractId: v.contract_id,
          proposalId: c.proposal_id_hex,
          signerEpoch: epoch,
          intent: a.intent,
        };
        expect(hex(approvalPayload(input)), `${c.name}/${a.intent}`).toBe(a.payload_borsh_hex);
        expect(hex(approvalChallenge(input)), `${c.name}/${a.intent}`).toBe(a.challenge_hex);
        expect(challengeB64u(input), `${c.name}/${a.intent}`).toBe(a.challenge_b64url);
      }
    }
  });

  it('recovery ids and their cancel challenges match the Rust vectors', () => {
    for (const r of v.recovery_ids) {
      const id = recoveryId(r.contract_id, BigInt(r.recovery_key_epoch), BigInt(r.nonce));
      expect(id).toBe(r.recovery_id_hex);
      const challenge = approvalChallenge({
        contractId: r.contract_id,
        proposalId: id,
        signerEpoch: epoch,
        intent: 'cancel',
      });
      expect(hex(challenge)).toBe(r.cancel_challenge_hex);
    }
  });

  it('the recovery payload and message match the Rust vector', () => {
    const r = readJson('recovery-payloads.json');
    const input = {
      contractId: r.contract_id,
      newSigners: r.new_signers,
      newThreshold: r.new_threshold,
      nonce: BigInt(r.nonce),
      recoveryKeyEpoch: BigInt(r.recovery_key_epoch),
      validUntil: BigInt(r.valid_until),
    };
    expect(hex(encodeRecoveryPayload(input))).toBe(r.payload_borsh_hex);
    expect(hex(recoveryMessage(input))).toBe(r.message_hex);
  });

  it('a different salt, epoch or intent changes the bytes', () => {
    const c = v.cases[0] as CaseVector;
    const action = ActionSchema.parse(c.action);
    expect(proposalId(action, new Uint8Array(32))).not.toBe(c.proposal_id_hex);
    const base = {
      contractId: v.contract_id,
      proposalId: c.proposal_id_hex,
      intent: 'approve' as const,
    };
    expect(challengeB64u({ ...base, signerEpoch: 4n })).not.toBe(
      challengeB64u({ ...base, signerEpoch: 3n }),
    );
  });

  it('rejects malformed actions instead of encoding them', () => {
    expect(() => ActionSchema.parse({ withdraw: { asset: 'x' } })).toThrow();
    expect(() => ActionSchema.parse({ unknown_variant: {} })).toThrow();
    expect(() => ActionSchema.parse({ set_threshold: 256 })).toThrow();
    expect(() =>
      ActionSchema.parse({ set_limits: { asset: 'a', per_tx: '-1', per_day: null } }),
    ).toThrow();
    // u128 overflow
    expect(() =>
      ActionSchema.parse({ set_refund_cap: { asset: 'a', daily: (2n ** 128n).toString() } }),
    ).toThrow();
    expect(() => ActionSchema.parse({ upgrade: { code_hash: 'AAAA' } })).toThrow();
    expect(() =>
      ActionSchema.parse({
        withdraw: {
          asset: 'a',
          amount: '1',
          saved_address_id: 's',
          route: { poa: { token_contract: 'NOT VALID' } },
        },
      }),
    ).toThrow();
    expect(() => ActionSchema.parse({ withdraw: {}, refund: {} })).toThrow();
  });

  it('encodes every variant in the contract order (variant index is the first byte)', () => {
    const key = { ed25519: Buffer.alloc(32, 1).toString('base64') };
    const samples: unknown[] = [
      { add_signer: { id: 'per_x', keys: [key] } },
      { remove_signer: { id: 'per_x' } },
      { add_signer_key: { id: 'per_x', key } },
      { remove_signer_key: { id: 'per_x', key } },
      { set_threshold: 2 },
      { set_origins: ['https://usetendr.tech'] },
      { rotate_recovery_key: null },
      { add_saved_address: { id: 'pal_1', chain: 'near', address: 'a.near' } },
      { remove_saved_address: { id: 'pal_1' } },
      { set_limits: { asset: 'a', per_tx: '5', per_day: null } },
      { set_refund_cap: { asset: 'a', daily: '1' } },
      { set_auto_sweep: { asset: 'a', trigger_above: '10', keep: '1', saved_address_id: 'pal_1' } },
      { clear_auto_sweep: { asset: 'a' } },
      {
        withdraw: {
          asset: 'a',
          amount: '1',
          saved_address_id: 'pal_1',
          route: { swap: { deposit_account: 'd.near' } },
        },
      },
      {
        refund: {
          asset: 'a',
          amount: '1',
          destination_chain: 'base',
          destination: '0x1',
          payment_id: 'pay_1',
          route: { poa: { token_contract: 't.near' } },
        },
      },
      { upgrade: { code_hash: Buffer.alloc(32, 7).toString('base64') } },
      { set_settlement: { dest_asset: 'a', payout_mode: 'intents', saved_address_id: null } },
    ];
    samples.forEach((s, i) => {
      expect(encodeAction(ActionSchema.parse(s))[0]).toBe(i);
    });
    // Spot-check field encodings against hand-built borsh.
    expect(hex(encodeAction(ActionSchema.parse({ set_threshold: 2 })))).toBe('0402');
    expect(hex(encodeAction(ActionSchema.parse({ rotate_recovery_key: null })))).toBe('0600');
    expect(
      hex(
        encodeAction(
          ActionSchema.parse({ set_limits: { asset: 'a', per_tx: '5', per_day: null } }),
        ),
      ),
    ).toBe('09' + '0100000061' + '01' + '05' + '00'.repeat(15) + '00');
    expect(
      hex(
        encodeAction(
          ActionSchema.parse({
            set_settlement: { dest_asset: 'a', payout_mode: 'wallet', saved_address_id: 'p' },
          }),
        ),
      ),
    ).toBe('10' + '0100000061' + '01' + '01' + '0100000070');
  });
});

describe('normalizeP256Signature', () => {
  const n = p256.CURVE.n;
  const msg = new Uint8Array(32).fill(9);
  const priv = new Uint8Array(32).fill(3);
  const low = p256.sign(msg, priv, { prehash: false, lowS: true });
  const pub = p256.getPublicKey(priv, true);

  it('normalize_flips_high_s', () => {
    const high = new p256.Signature(low.r, n - low.s);
    expect(high.hasHighS()).toBe(true);
    const raw = normalizeP256Signature(high.toDERRawBytes());
    expect(raw).toHaveLength(64);
    const back = p256.Signature.fromCompact(raw);
    expect(back.r).toBe(low.r);
    expect(back.s).toBe(low.s);
    expect(back.hasHighS()).toBe(false);
    expect(p256.verify(raw, msg, pub, { prehash: false, lowS: true })).toBe(true);
  });

  it('keeps a low-s signature as r‖s', () => {
    const raw = normalizeP256Signature(low.toDERRawBytes());
    expect(Buffer.from(raw).equals(Buffer.from(low.toCompactRawBytes()))).toBe(true);
  });

  it('rejects bytes that are not a DER signature', () => {
    expect(() => normalizeP256Signature(new Uint8Array(64))).toThrow();
  });
});
