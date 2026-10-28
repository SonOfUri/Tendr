// Solana gasless signing through Pimlico's paymaster (Kora, spec §2.3): the API builds a v0
// transaction whose fee payer is the paymaster; the shopper's wallet only signs it (never sends
// it), and Tendr relays it. Before the wallet sees it, the transaction is decoded here and must
// hold exactly: compute-budget settings within bounds, idempotent token-account creation paid by
// the paymaster, the payment `transferChecked` to the deposit address's token account for the
// quoted amount, and — only when the shopper pays the fee — one `transferChecked` of the quoted fee
// to the fee account. Nothing else, nothing after.
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { base64ToBytes, bytesToBase64 } from '@/lib/base58';
import { WalletError, toWalletError } from '../errors';
import type { PayTarget } from '../index';
import {
  GaslessExpiredError,
  mismatch,
  uintOf,
  type GaslessMethod,
  type GaslessSigner,
} from './index';

export const SOLANA_TO_SIGN_KIND = 'solana_transaction';
/** The API's bounds (relayer/solana-tx.ts). */
const MAX_COMPUTE_UNIT_LIMIT = 200_000;
const MAX_COMPUTE_UNIT_PRICE = 1_000_000n;
const TRANSFER_CHECKED = 12;

export interface SolanaSignerLike {
  signTransaction?(tx: VersionedTransaction): Promise<VersionedTransaction>;
}

export interface SolanaGaslessDeps {
  provider(): SolanaSignerLike | undefined;
  address(): string | null;
  connection(): Promise<{ getBalance?(pk: PublicKey): Promise<number> }>;
}

function pk(v: unknown, field: string): PublicKey {
  if (typeof v !== 'string') throw mismatch(field);
  try {
    return new PublicKey(v);
  } catch {
    throw mismatch(field);
  }
}

const u64 = (d: Uint8Array, at: number) => {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(d[at + i]!);
  return n;
};
const u32 = (d: Uint8Array, at: number) =>
  Number(u64(new Uint8Array([...d.slice(at, at + 4), 0, 0, 0, 0]), 0));

interface KoraTypedData {
  transaction: string;
  fee_payer: string;
  expires_at: string;
  transfers: { leg: string; mint: string; to: string; token_account: string; amount: string }[];
}

/** Decodes and checks the prepared transaction; returns it unsigned. */
export function checkKoraTransaction(
  typed: unknown,
  target: PayTarget,
  e: { wallet: string; depositAddress: string; amount: bigint; fee: bigint },
): VersionedTransaction {
  const td = typed as KoraTypedData | null;
  if (!td || typeof td.transaction !== 'string') throw mismatch('transaction');
  const mint = pk(target.contract, 'mint');
  if (target.decimals === undefined) throw mismatch('mint');
  const wallet = pk(e.wallet, 'signer');
  const deposit = pk(e.depositAddress, 'deposit');
  const feePayer = pk(td.fee_payer, 'fee_payer');
  if (feePayer.equals(wallet)) throw mismatch('fee_payer');

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(base64ToBytes(td.transaction));
  } catch {
    throw mismatch('transaction');
  }
  const msg = tx.message;
  if (msg.version !== 0 || msg.addressTableLookups.length > 0) throw mismatch('transaction');
  const keys = msg.staticAccountKeys;
  if (
    msg.header.numRequiredSignatures !== 2 ||
    !keys[0]?.equals(feePayer) ||
    !keys[1]?.equals(wallet)
  ) {
    throw mismatch('transaction.signers');
  }

  // The fee account (only when the shopper pays), from the payload's own transfer list.
  let feeOwner: PublicKey | null = null;
  if (e.fee > 0n) {
    const leg = Array.isArray(td.transfers)
      ? td.transfers.find((t) => t?.leg === 'fee')
      : undefined;
    feeOwner = pk(leg?.to, 'fee');
    if (feeOwner.equals(deposit) || feeOwner.equals(wallet)) throw mismatch('fee');
  }
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  const walletAta = ata(wallet);

  let ixs: TransactionInstruction[];
  try {
    ixs = TransactionMessage.decompile(msg).instructions;
  } catch {
    throw mismatch('transaction');
  }
  let i = 0;
  let limit = false;
  let price = false;
  for (; i < ixs.length && ixs[i]!.programId.equals(ComputeBudgetProgram.programId); i++) {
    const d = ixs[i]!.data;
    if (d[0] === 2 && d.length === 5 && !limit) {
      limit = true;
      if (u32(d, 1) > MAX_COMPUTE_UNIT_LIMIT) throw mismatch('compute_unit_limit');
    } else if (d[0] === 3 && d.length === 9 && !price) {
      price = true;
      if (u64(d, 1) > MAX_COMPUTE_UNIT_PRICE) throw mismatch('compute_unit_price');
    } else {
      throw mismatch(`instructions[${i}]`);
    }
  }
  const created = new Set<string>();
  for (; i < ixs.length && ixs[i]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID); i++) {
    const ix = ixs[i]!;
    const k = ix.keys.map((x) => x.pubkey);
    const owner = k[2];
    const ownerOk =
      owner && (owner.equals(deposit) || (feeOwner !== null && owner.equals(feeOwner)));
    if (
      ix.data.length !== 1 ||
      ix.data[0] !== 1 ||
      k.length !== 6 ||
      !k[0]!.equals(feePayer) ||
      !ownerOk ||
      !k[1]!.equals(ata(owner!)) ||
      !k[3]!.equals(mint) ||
      !k[4]!.equals(SystemProgram.programId) ||
      !k[5]!.equals(TOKEN_PROGRAM_ID) ||
      created.has(owner!.toBase58())
    ) {
      throw mismatch(`instructions[${i}]`);
    }
    created.add(owner!.toBase58());
  }

  const transfer = (to: PublicKey, amount: bigint, field: string) => {
    const ix = ixs[i];
    if (!ix || !ix.programId.equals(TOKEN_PROGRAM_ID)) throw mismatch(field);
    const k = ix.keys.map((x) => x.pubkey);
    const d = ix.data;
    if (d.length !== 10 || d[0] !== TRANSFER_CHECKED || k.length !== 4) throw mismatch(field);
    if (!k[0]!.equals(walletAta) || !k[3]!.equals(wallet)) throw mismatch(field);
    if (!k[1]!.equals(mint)) throw mismatch(`${field}.mint`);
    if (!k[2]!.equals(ata(to))) throw mismatch(`${field}.to`);
    if (u64(d, 1) !== amount) throw mismatch(`${field}.amount`);
    if (d[9] !== target.decimals) throw mismatch(`${field}.decimals`);
    i++;
  };
  transfer(deposit, e.amount, 'payment');
  if (feeOwner) transfer(feeOwner, e.fee, 'fee');
  if (i !== ixs.length) throw mismatch(`instructions[${i}]`);
  // Every account in the message is used by an instruction (no stray writable accounts).
  const used = new Set(
    ixs.flatMap((x) => [x.programId, ...x.keys.map((k) => k.pubkey)]).map((p) => p.toBase58()),
  );
  if (keys.some((k) => !used.has(k.toBase58()))) throw mismatch('transaction.accounts');
  return tx;
}

export function createSolanaGasless(target: PayTarget, deps: SolanaGaslessDeps): GaslessSigner {
  if (target.family !== 'solana') throw new WalletError('failed', { detail: 'not a Solana asset' });
  return {
    async methods(): Promise<GaslessMethod[]> {
      // Kora needs a wallet that signs without sending; SPL tokens only.
      return target.kind === 'token' && typeof deps.provider()?.signTransaction === 'function'
        ? ['kora']
        : [];
    },
    async nativeBalance() {
      const a = deps.address();
      if (!a) return null;
      try {
        const c = await deps.connection();
        const lamports = await c.getBalance?.(new PublicKey(a));
        return typeof lamports === 'number' && Number.isSafeInteger(lamports)
          ? BigInt(lamports)
          : null;
      } catch {
        return null;
      }
    },
    async sign(p, e) {
      const provider = deps.provider();
      const address = deps.address();
      if (!provider?.signTransaction || !address) {
        throw new WalletError('failed', { detail: 'not connected' });
      }
      if (address !== e.wallet) throw new WalletError('account_changed', { address });
      if (p.to_sign.length !== 1 || p.to_sign[0]!.kind !== SOLANA_TO_SIGN_KIND) {
        throw mismatch('to_sign');
      }
      const typed = p.to_sign[0]!.typed_data as { expires_at?: unknown };
      const expires = Date.parse(String(typed?.expires_at));
      // The blockhash lasts about a minute: past it the API refuses, so prepare again first.
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new GaslessExpiredError();
      uintOf(p.amount, 'amount');
      const tx = checkKoraTransaction(typed, target, e);
      const message = bytesToBase64(tx.message.serialize());
      let wire: Uint8Array;
      try {
        const signed = await provider.signTransaction(tx);
        wire = signed.serialize();
      } catch (err) {
        // Only a signature: Tendr relays it, so nothing was sent.
        throw toWalletError(err);
      }
      // Re-read from the bytes the wallet returned (it may use another web3.js copy): the same
      // message, signed by the wallet, and nothing else changed.
      let back: VersionedTransaction;
      try {
        back = VersionedTransaction.deserialize(wire);
      } catch {
        throw mismatch('signed_transaction');
      }
      if (
        bytesToBase64(back.message.serialize()) !== message ||
        !back.signatures[1]?.some((b) => b !== 0)
      ) {
        throw mismatch('signed_transaction');
      }
      return { kind: 'submit', body: { transaction: bytesToBase64(wire) } };
    },
  };
}
