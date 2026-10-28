import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { describe, expect, it, vi } from 'vitest';
import { payTargetFor } from '../index';
import { createSolanaGasless } from './solana';
import {
  GaslessExpiredError,
  GaslessMismatchError,
  type GaslessExpectation,
  type PreparePayload,
} from './index';

const USDC = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const OTHER_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const target = payTargetFor(USDC)!;
const wallet = Keypair.generate();
const payer = Keypair.generate().publicKey;
const deposit = Keypair.generate().publicKey;
const feeOwner = Keypair.generate().publicKey;
const DEADLINE = new Date(Date.now() + 10 * 60_000).toISOString();
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner, true);

function expectation(fee: bigint): GaslessExpectation {
  return {
    quoteId: 'quo_1',
    method: 'kora',
    target,
    wallet: wallet.publicKey.toBase58(),
    depositAddress: deposit.toBase58(),
    amount: 25_000_000n,
    fee,
    deadline: DEADLINE,
    livemode: true,
  };
}

function instructions(fee: bigint): TransactionInstruction[] {
  const w = wallet.publicKey;
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer, ata(deposit), deposit, MINT),
    ...(fee > 0n
      ? [createAssociatedTokenAccountIdempotentInstruction(payer, ata(feeOwner), feeOwner, MINT)]
      : []),
    createTransferCheckedInstruction(ata(w), MINT, ata(deposit), w, 25_000_000n, 6),
    ...(fee > 0n ? [createTransferCheckedInstruction(ata(w), MINT, ata(feeOwner), w, fee, 6)] : []),
  ];
}

function prepared(
  fee: bigint,
  ixs: TransactionInstruction[] = instructions(fee),
  over: Record<string, unknown> = {},
  feePayer: PublicKey = payer,
): PreparePayload {
  const msg = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return {
    quote_id: 'quo_1',
    method: 'kora',
    chain: 'sol',
    chain_id: null,
    signer: wallet.publicKey.toBase58(),
    deadline: DEADLINE,
    amount: '25000000',
    fee_amount: fee.toString(),
    to_sign: [
      {
        kind: 'solana_transaction',
        typed_data: {
          transaction: Buffer.from(tx.serialize()).toString('base64'),
          message: Buffer.from(msg.serialize()).toString('base64'),
          fee_payer: payer.toBase58(),
          blockhash: msg.recentBlockhash,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          transfers: [
            {
              leg: 'payment',
              mint: MINT.toBase58(),
              to: deposit.toBase58(),
              token_account: ata(deposit).toBase58(),
              amount: '25000000',
            },
            ...(fee > 0n
              ? [
                  {
                    leg: 'fee',
                    mint: MINT.toBase58(),
                    to: feeOwner.toBase58(),
                    token_account: ata(feeOwner).toBase58(),
                    amount: fee.toString(),
                  },
                ]
              : []),
          ],
          ...over,
        },
      },
    ],
  };
}

function signer(opts: { tamper?: boolean; noSign?: boolean } = {}) {
  const signTransaction = vi.fn(async (tx: VersionedTransaction) => {
    if (opts.tamper) {
      // A wallet that rewrites the transaction it was asked to sign.
      tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    }
    tx.sign([wallet]);
    return tx;
  });
  const s = createSolanaGasless(target, {
    provider: () => (opts.noSign ? {} : { signTransaction }),
    address: () => wallet.publicKey.toBase58(),
    connection: async () => ({
      getLatestBlockhash: async () => ({ blockhash: 'x', lastValidBlockHeight: 1 }),
      getBalance: async () => 5_000_000,
    }),
  });
  return { s, signTransaction };
}

async function refused(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GaslessMismatchError);
  return (err as GaslessMismatchError).field;
}

describe('Solana gasless (Kora)', () => {
  it('offers kora only to wallets that can sign without sending', async () => {
    expect(await signer().s.methods()).toEqual(['kora']);
    expect(await signer({ noSign: true }).s.methods()).toEqual([]);
    expect(await signer().s.nativeBalance()).toBe(5_000_000n);
  });

  it('sponsored: signs the exact transaction and returns it base64', async () => {
    const { s, signTransaction } = signer();
    const p = prepared(0n);
    const r = await s.sign(p, expectation(0n));
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe('submit');
    const tx = VersionedTransaction.deserialize(
      Buffer.from((r as { body: { transaction: string } }).body.transaction, 'base64'),
    );
    expect(tx.signatures[1]!.some((b) => b !== 0)).toBe(true);
    expect(Buffer.from(tx.message.serialize()).toString('base64')).toBe(
      (p.to_sign[0]!.typed_data as { message: string }).message,
    );
  });

  it('shopper pays: the fee transfer to the gas-fee account is accepted', async () => {
    const r = await signer().s.sign(prepared(96_000n), expectation(96_000n));
    expect(r.kind).toBe('submit');
  });

  const w = () => wallet.publicKey;
  it.each<[string, bigint, () => PreparePayload]>([
    [
      'an extra instruction',
      0n,
      () =>
        prepared(0n, [
          ...instructions(0n),
          SystemProgram.transfer({ fromPubkey: w(), toPubkey: feeOwner, lamports: 1 }),
        ]),
    ],
    [
      'another amount',
      0n,
      () =>
        prepared(0n, [
          ...instructions(0n).slice(0, 3),
          createTransferCheckedInstruction(ata(w()), MINT, ata(deposit), w(), 25_000_001n, 6),
        ]),
    ],
    [
      'another destination',
      0n,
      () =>
        prepared(0n, [
          ...instructions(0n).slice(0, 2),
          createAssociatedTokenAccountIdempotentInstruction(payer, ata(feeOwner), feeOwner, MINT),
          createTransferCheckedInstruction(ata(w()), MINT, ata(feeOwner), w(), 25_000_000n, 6),
        ]),
    ],
    [
      'another mint',
      0n,
      () =>
        prepared(0n, [
          ...instructions(0n).slice(0, 3),
          createTransferCheckedInstruction(
            getAssociatedTokenAddressSync(OTHER_MINT, w(), true),
            OTHER_MINT,
            getAssociatedTokenAddressSync(OTHER_MINT, deposit, true),
            w(),
            25_000_000n,
            6,
          ),
        ]),
    ],
    ['a fee leg nobody quoted', 0n, () => prepared(0n, instructions(96_000n))],
    ['a missing fee leg', 96_000n, () => prepared(96_000n, instructions(0n))],
    [
      'a high compute price',
      0n,
      () =>
        prepared(0n, [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }),
          ...instructions(0n).slice(2),
        ]),
    ],
    ['the shopper as fee payer', 0n, () => prepared(0n, instructions(0n), {}, wallet.publicKey)],
  ])('refuses %s before the wallet is asked', async (_n, fee, make) => {
    const { s, signTransaction } = signer();
    await refused(s.sign(make(), expectation(fee)));
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('a payload past its signing window is re-prepared, not signed', async () => {
    const { s, signTransaction } = signer();
    const p = prepared(0n, instructions(0n), {
      expires_at: new Date(Date.now() - 1).toISOString(),
    });
    await expect(s.sign(p, expectation(0n))).rejects.toBeInstanceOf(GaslessExpiredError);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('refuses a wallet that changed the transaction while signing', async () => {
    const { s } = signer({ tamper: true });
    expect(await refused(s.sign(prepared(0n), expectation(0n)))).toBe('signed_transaction');
  });
});
