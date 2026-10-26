// Solana deposits through AppKit's Solana adapter. SOL is one System transfer; an SPL token (only
// the verified mints in wallets/index.ts) creates the deposit address's token account when it
// has none (idempotent, paid by the shopper's wallet) and then `transferChecked` with the mint's
// decimals. The wallet must be on Solana mainnet.
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { WalletError, afterSignError, toWalletError } from './errors';
import type { DepositRequest, PayTarget, WalletAdapter } from './index';
import { assertDepositMatches } from './match';
import type { AppKitSession } from './appkit';

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export interface SolanaProviderLike {
  sendTransaction(tx: Transaction, connection: never): Promise<string>;
}

export interface SolanaConnectionLike {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

function publicKey(s: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new WalletError('failed', { detail: 'bad Solana address' });
  }
}

/** The instructions that pay `q` from `from`. */
export function buildSolanaInstructions(
  target: PayTarget,
  q: DepositRequest,
  from: string,
): TransactionInstruction[] {
  const amount = assertDepositMatches(target, q);
  const payer = publicKey(from);
  const to = publicKey(q.depositAddress);
  if (target.kind === 'native') {
    return [SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: amount })];
  }
  if (!target.contract || target.decimals === undefined) {
    throw new WalletError('failed', { detail: 'unknown mint' });
  }
  const mint = publicKey(target.contract);
  const source = getAssociatedTokenAddressSync(mint, payer, true);
  const destination = getAssociatedTokenAddressSync(mint, to, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, destination, to, mint),
    createTransferCheckedInstruction(source, mint, destination, payer, amount, target.decimals),
  ];
}

/** A mainnet RPC connection through Reown's RPC (already in the checkout's connect-src). */
export async function solanaConnection(projectId: string) {
  const { Connection } = await import('@solana/web3.js');
  return new Connection(
    `https://rpc.walletconnect.org/v1/?chainId=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dKmFq&projectId=${encodeURIComponent(projectId)}`,
    'confirmed',
  );
}

export function createSolanaAdapter(
  target: PayTarget,
  deps: {
    session: AppKitSession<SolanaProviderLike>;
    connection: () => SolanaConnectionLike | Promise<SolanaConnectionLike>;
  },
): WalletAdapter {
  if (target.family !== 'solana') throw new WalletError('failed', { detail: 'not a Solana asset' });
  let address: string | null = null;
  return {
    chainFamily: 'solana',
    async connect() {
      try {
        const r = await deps.session.connect();
        publicKey(r.address);
        address = r.address;
        return { address };
      } catch (err) {
        throw toWalletError(err);
      }
    },
    async sendDeposit(q) {
      const provider = deps.session.provider();
      if (!address || !provider) throw new WalletError('failed', { detail: 'not connected' });
      const instructions = buildSolanaInstructions(target, q, address);
      if (!(await deps.session.ensureNetwork())) {
        throw new WalletError('chain_mismatch', { network: 'Solana' });
      }
      let connection: SolanaConnectionLike;
      let tx: Transaction;
      try {
        connection = await deps.connection();
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        tx = new Transaction({ feePayer: publicKey(address), blockhash, lastValidBlockHeight });
        tx.add(...instructions);
      } catch (err) {
        throw toWalletError(err);
      }
      let signature: unknown;
      try {
        // The wallet signs AND broadcasts here: past a refusal, a throw (a confirmation timeout,
        // a dropped connection) may come after the transaction went out. Possibly sent (C32).
        signature = await provider.sendTransaction(tx, connection as never);
      } catch (err) {
        throw afterSignError(err);
      }
      if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
        throw new WalletError('uncertain', { detail: 'no signature' });
      }
      return { txHash: signature };
    },
    async disconnect() {
      address = null;
      await deps.session.disconnect();
    },
  };
}
