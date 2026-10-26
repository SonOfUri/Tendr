import { PublicKey, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { describe, expect, it, vi } from 'vitest';
import { WalletError } from './errors';
import { payTargetFor, type DepositRequest } from './index';
import { buildSolanaInstructions, createSolanaAdapter } from './solana';

const SOL = 'nep141:sol.omft.near';
const USDC = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SHOPPER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const DEPOSIT = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';

const sol: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: SOL,
  amount: '560000001',
  decimals: 9,
};
const usdc: DepositRequest = {
  depositAddress: DEPOSIT,
  assetId: USDC,
  amount: '84000000',
  decimals: 6,
};

describe('Solana deposits', () => {
  it('SOL is one System transfer of the exact lamports', () => {
    const [ix, ...rest] = buildSolanaInstructions(payTargetFor(SOL)!, sol, SHOPPER);
    expect(rest).toEqual([]);
    expect(ix!.programId.equals(SystemProgram.programId)).toBe(true);
    const t = SystemInstruction.decodeTransfer(ix!);
    expect(BigInt(t.lamports)).toBe(560000001n);
    expect(t.fromPubkey.toBase58()).toBe(SHOPPER);
    expect(t.toPubkey.toBase58()).toBe(DEPOSIT);
  });

  it("an SPL token creates the deposit address's token account if needed, then transferChecked", () => {
    const ixs = buildSolanaInstructions(payTargetFor(USDC)!, usdc, SHOPPER);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    // Idempotent create: instruction data [1].
    expect(Array.from(ixs[0]!.data)).toEqual([1]);
    const destAta = getAssociatedTokenAddressSync(MINT, new PublicKey(DEPOSIT), true);
    expect(ixs[0]!.keys[1]!.pubkey.equals(destAta)).toBe(true);

    expect(ixs[1]!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    const d = decodeTransferCheckedInstruction(ixs[1]!);
    expect(d.data.amount).toBe(84000000n);
    expect(d.data.decimals).toBe(6);
    expect(d.keys.mint.pubkey.equals(MINT)).toBe(true);
    expect(d.keys.destination.pubkey.equals(destAta)).toBe(true);
    expect(d.keys.owner.pubkey.toBase58()).toBe(SHOPPER);
  });

  it("refuses a token whose decimals don't match the known mint", () => {
    expect(() =>
      buildSolanaInstructions(payTargetFor(USDC)!, { ...usdc, decimals: 9 }, SHOPPER),
    ).toThrow(WalletError);
  });

  function deps(onMainnet: boolean) {
    const sendTransaction = vi.fn(async (_tx: Transaction) => '5'.repeat(88));
    return {
      sendTransaction,
      deps: {
        session: {
          connect: vi.fn(async () => ({ address: SHOPPER })),
          provider: () => ({ sendTransaction }),
          ensureNetwork: vi.fn(async () => onMainnet),
          disconnect: vi.fn(async () => {}),
        },
        connection: () => ({
          getLatestBlockhash: async () => ({
            blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',
            lastValidBlockHeight: 1,
          }),
        }),
      },
    };
  }

  it('sends through the wallet on mainnet and returns the signature', async () => {
    const { deps: d, sendTransaction } = deps(true);
    const adapter = createSolanaAdapter(payTargetFor(USDC)!, d);
    expect(await adapter.connect()).toEqual({ address: SHOPPER });
    expect(await adapter.sendDeposit(usdc)).toEqual({ txHash: '5'.repeat(88) });
    const tx = sendTransaction.mock.calls[0]![0];
    expect(tx.feePayer?.toBase58()).toBe(SHOPPER);
    expect(tx.instructions).toHaveLength(2);
  });

  it('a wallet that is not on Solana mainnet blocks the send', async () => {
    const { deps: d, sendTransaction } = deps(false);
    const adapter = createSolanaAdapter(payTargetFor(SOL)!, d);
    await adapter.connect();
    const err = await adapter.sendDeposit(sol).catch((e: unknown) => e);
    expect((err as WalletError).kind).toBe('chain_mismatch');
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('a wallet error after it was asked to sign and send is "possibly sent"; a refusal is not', async () => {
    const { deps: d, sendTransaction } = deps(true);
    const adapter = createSolanaAdapter(payTargetFor(SOL)!, d);
    await adapter.connect();
    sendTransaction.mockRejectedValueOnce(new Error('Transaction was not confirmed in 30 seconds'));
    expect(((await adapter.sendDeposit(sol).catch((e: unknown) => e)) as WalletError).kind).toBe(
      'uncertain',
    );
    sendTransaction.mockRejectedValueOnce(
      Object.assign(new Error('User rejected'), { code: 4001 }),
    );
    expect(((await adapter.sendDeposit(sol).catch((e: unknown) => e)) as WalletError).kind).toBe(
      'rejected',
    );
  });
});
