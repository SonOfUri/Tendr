// The Solana gasless payment transaction (project 5a, spec §2.3 Solana, rulings T7-a, T7-b): what
// Tendr builds for the shopper to sign, and the exact check of what comes back signed.
//
// A v0 transaction whose fee payer is Pimlico's Kora paymaster (it signs last, at submit), with
// exactly, in this order:
//
//   ComputeBudget SetComputeUnitLimit / SetComputeUnitPrice      optional, at most one each, bounded
//   ATA CreateIdempotent(payer = paymaster, deposit address)     optional (when the account is new)
//   ATA CreateIdempotent(payer = paymaster, gas-fees-solana)     optional, only when the shopper pays
//   Token TransferChecked(shopper's ATA → deposit address's ATA, amount_in, authority = wallet)
//   Token TransferChecked(shopper's ATA → gas-fees-solana's ATA, fee_amount)   iff the shopper pays
//
// Anything else (another instruction, program, account, signer, lookup table, amount or
// destination) is refused before Pimlico is called. The deposit address and amounts come from the
// quote, the fee owner from the `gas-fees-solana` key; nothing is taken from the request. The whole
// transaction is atomic: the fee and the payment land together or not at all.
//
// Only SPL Token program mints are listed: Token-2022 mints (transfer fees, hooks) are never
// gasless, and no fee-on-transfer or rebasing token is listed.
import { ed25519 } from '@noble/curves/ed25519';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  isAddress,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import bs58 from 'bs58';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM: string = TOKEN_PROGRAM_ADDRESS;
export const ASSOCIATED_TOKEN_PROGRAM: string = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;

/** Compute units the prepared transaction requests (two ATA creates + two transfers fit). */
export const SOLANA_GASLESS_CU_LIMIT = 100_000;
/** The most compute units a signed transaction may request. */
export const SOLANA_MAX_CU_LIMIT = 200_000;
/**
 * The highest compute-unit price (micro-lamports per CU) a signed transaction may set: at the
 * limit above, at most 200 000 lamports (0.0002 SOL) of priority fee from Tendr's Pimlico balance.
 */
export const SOLANA_MAX_CU_PRICE = 1_000_000n;
/** Solana's packet limit for a whole transaction. */
const MAX_TRANSACTION_BYTES = 1232;

/** A gasless SPL token: the 1Click asset, its mint (SPL Token program only) and decimals. */
export interface SolanaGaslessToken {
  assetId: string;
  symbol: string;
  mint: string;
  decimals: number;
}

/**
 * The Solana gasless allow-list: Circle's USDC and Tether's USDT, both SPL Token program mints
 * without transfer fees or hooks. The 1Click asset ids and mints are confirmed against the 1Click
 * token list's `contractAddress` before go-live (README live checklist).
 */
export const SOLANA_GASLESS_TOKENS: readonly SolanaGaslessToken[] = [
  {
    assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  },
  {
    assetId: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
  },
];

/** The allow-listed token behind a 1Click asset, or null (no gasless option). */
export function solanaGaslessToken(assetId: string): SolanaGaslessToken | null {
  return SOLANA_GASLESS_TOKENS.find((t) => t.assetId === assetId) ?? null;
}

/** Everything the transaction must bind (from the quote, the paymaster and Tendr's own key). */
export interface SolanaPayment {
  /** Kora's fee payer (Pimlico's paymaster signer). */
  feePayer: string;
  /** The quote's wallet: the only other signer, the transfers' authority. */
  wallet: string;
  mint: string;
  decimals: number;
  depositAddress: string;
  amount: bigint;
  /** The `gas-fees-solana` owner when the shopper pays the fee in the token; else null. */
  feeOwner: string | null;
  /** The fee in token base units (0 when the merchant sponsors). */
  fee: bigint;
}

/** The token accounts a payment uses (associated token accounts of the SPL Token program). */
export interface PaymentAccounts {
  source: string;
  deposit: string;
  fee: string | null;
}

export async function associatedTokenAccount(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

export async function paymentAccounts(p: SolanaPayment): Promise<PaymentAccounts> {
  const [source, deposit, fee] = await Promise.all([
    associatedTokenAccount(p.wallet, p.mint),
    associatedTokenAccount(p.depositAddress, p.mint),
    p.feeOwner && p.fee > 0n ? associatedTokenAccount(p.feeOwner, p.mint) : null,
  ]);
  return { source, deposit, fee };
}

export interface BuildOptions {
  blockhash: string;
  /** Include the idempotent create of the deposit address's / gas-fee owner's token account. */
  createDeposit: boolean;
  createFee: boolean;
  cuLimit: number;
  /** Micro-lamports per compute unit (0: no price instruction). */
  cuPrice: bigint;
}

/** The unsigned transaction (base64 wire bytes, both signature slots empty) and its message. */
export async function buildPaymentTransaction(
  p: SolanaPayment,
  o: BuildOptions,
): Promise<{ transaction: string; message: string; accounts: PaymentAccounts }> {
  const accounts = await paymentAccounts(p);
  const mint = address(p.mint);
  const payer = createNoopSigner(address(p.feePayer));
  const authority = createNoopSigner(address(p.wallet));
  const ixs: Instruction[] = [];
  if (o.createDeposit) {
    ixs.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: address(accounts.deposit),
        owner: address(p.depositAddress),
        mint,
      }),
    );
  }
  if (o.createFee && accounts.fee && p.feeOwner) {
    ixs.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata: address(accounts.fee),
        owner: address(p.feeOwner),
        mint,
      }),
    );
  }
  ixs.push(
    getTransferCheckedInstruction({
      source: address(accounts.source),
      mint,
      destination: address(accounts.deposit),
      authority,
      amount: p.amount,
      decimals: p.decimals,
    }),
  );
  if (accounts.fee) {
    ixs.push(
      getTransferCheckedInstruction({
        source: address(accounts.source),
        mint,
        destination: address(accounts.fee),
        authority,
        amount: p.fee,
        decimals: p.decimals,
      }),
    );
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(p.feePayer), m),
    (m) =>
      // The paymaster's blockhash; its block height is not needed to build the message.
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash(o.blockhash), lastValidBlockHeight: 0n },
        m,
      ),
    (m) => (o.cuLimit > 0 ? setTransactionMessageComputeUnitLimit(o.cuLimit, m) : m),
    (m) => (o.cuPrice > 0n ? setTransactionMessageComputeUnitPrice(o.cuPrice, m) : m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = compileTransaction(message);
  return {
    transaction: getBase64EncodedWireTransaction(tx),
    message: Buffer.from(tx.messageBytes).toString('base64'),
    accounts,
  };
}

/** A signed transaction does not match the quote; `field` names the first difference. */
export class SolanaTxMismatch extends Error {
  constructor(readonly field: string) {
    super(`the signed transaction does not match the quote (${field})`);
    this.name = 'SolanaTxMismatch';
  }
}

export interface CheckedTransaction {
  /** The base64 wire transaction, exactly as signed. */
  transaction: string;
  blockhash: string;
  /** The shopper's signature (base58): unique to this message. */
  shopperSignature: string;
}

function readCompactU16(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const b = bytes[at + i];
    if (b === undefined) throw new SolanaTxMismatch('transaction');
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return [value, at + i + 1];
  }
  throw new SolanaTxMismatch('transaction');
}

const u64le = (d: Uint8Array, at: number) =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
const u32le = (d: Uint8Array, at: number) =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true);

/**
 * Decodes a partially signed transaction and checks it is exactly the payment `p` (see the file
 * header), signed by the wallet and not yet by the fee payer. Throws SolanaTxMismatch.
 */
export async function checkPaymentTransaction(
  p: SolanaPayment,
  base64: string,
  limits: { maxCuLimit: number; maxCuPrice: bigint } = {
    maxCuLimit: SOLANA_MAX_CU_LIMIT,
    maxCuPrice: SOLANA_MAX_CU_PRICE,
  },
): Promise<CheckedTransaction> {
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (
    bytes.length === 0 ||
    bytes.length > MAX_TRANSACTION_BYTES ||
    Buffer.from(bytes).toString('base64') !== base64
  ) {
    throw new SolanaTxMismatch('transaction');
  }
  const [count, sigStart] = readCompactU16(bytes, 0);
  if (count !== 2 || bytes.length < sigStart + 128) {
    throw new SolanaTxMismatch('transaction.signatures');
  }
  const feePayerSig = bytes.slice(sigStart, sigStart + 64);
  const shopperSig = bytes.slice(sigStart + 64, sigStart + 128);
  const messageBytes = bytes.slice(sigStart + 128);

  let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  try {
    msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
    // Canonical encoding only (no trailing or ambiguous bytes).
    const again = getCompiledTransactionMessageEncoder().encode(msg);
    if (Buffer.compare(Buffer.from(again), Buffer.from(messageBytes)) !== 0) throw new Error();
  } catch {
    throw new SolanaTxMismatch('transaction');
  }
  if (msg.version !== 0) throw new SolanaTxMismatch('transaction.version');
  if ('addressTableLookups' in msg && (msg.addressTableLookups?.length ?? 0) > 0) {
    throw new SolanaTxMismatch('transaction.address_table_lookups');
  }
  const keys = msg.staticAccounts as readonly string[];
  if (new Set(keys).size !== keys.length) throw new SolanaTxMismatch('transaction.accounts');
  if (msg.header.numSignerAccounts !== 2 || msg.header.numReadonlySignerAccounts !== 1) {
    throw new SolanaTxMismatch('transaction.signers');
  }
  if (keys[0] !== p.feePayer) throw new SolanaTxMismatch('transaction.fee_payer');
  if (keys[1] !== p.wallet) throw new SolanaTxMismatch('transaction.signer');
  // The paymaster signs at submit; the slot must be empty.
  if (feePayerSig.some((b) => b !== 0)) {
    throw new SolanaTxMismatch('transaction.fee_payer_signature');
  }
  let validSig = false;
  try {
    validSig = ed25519.verify(
      shopperSig,
      messageBytes,
      getAddressEncoder().encode(address(p.wallet)) as Uint8Array,
    );
  } catch {
    validSig = false;
  }
  if (!validSig) throw new SolanaTxMismatch('transaction.signature');

  const accounts = await paymentAccounts(p);
  const used = new Set<number>([0, 1]);
  const ixs = msg.instructions;
  const accountsOf = (i: number, n: number): string[] => {
    const idx = ixs[i]!.accountIndices ?? [];
    if (idx.length !== n) throw new SolanaTxMismatch(`transaction.instructions[${i}]`);
    return idx.map((k) => {
      const key = keys[k];
      if (key === undefined) throw new SolanaTxMismatch(`transaction.instructions[${i}]`);
      used.add(k);
      return key;
    });
  };
  const programOf = (i: number) => {
    const k = ixs[i]!.programAddressIndex;
    used.add(k);
    return keys[k];
  };
  const dataOf = (i: number) => (ixs[i]!.data ?? new Uint8Array()) as Uint8Array;

  let i = 0;
  // Compute budget: at most one unit limit and one unit price, both bounded.
  let limitSeen = false;
  let priceSeen = false;
  while (i < ixs.length && programOf(i) === COMPUTE_BUDGET_PROGRAM) {
    const d = dataOf(i);
    accountsOf(i, 0);
    if (d[0] === 2 && d.length === 5 && !limitSeen) {
      const limit = u32le(d, 1);
      if (limit === 0 || limit > limits.maxCuLimit) {
        throw new SolanaTxMismatch('transaction.compute_unit_limit');
      }
      limitSeen = true;
    } else if (d[0] === 3 && d.length === 9 && !priceSeen) {
      if (u64le(d, 1) > limits.maxCuPrice) {
        throw new SolanaTxMismatch('transaction.compute_unit_price');
      }
      priceSeen = true;
    } else {
      throw new SolanaTxMismatch(`transaction.instructions[${i}]`);
    }
    i++;
  }
  // Without a limit the runtime allows 200 000 CU per instruction: a price needs a limit.
  if (priceSeen && !limitSeen) throw new SolanaTxMismatch('transaction.compute_unit_limit');
  // Idempotent creates of the deposit's and the gas-fee owner's token accounts, paymaster pays.
  const creatable = new Map<string, string>([[accounts.deposit, p.depositAddress]]);
  if (accounts.fee && p.feeOwner) creatable.set(accounts.fee, p.feeOwner);
  while (i < ixs.length && programOf(i) === ASSOCIATED_TOKEN_PROGRAM) {
    const d = dataOf(i);
    const [payer, ata, owner, mint, system, token] = accountsOf(i, 6);
    if (
      d.length !== 1 ||
      d[0] !== 1 ||
      payer !== p.feePayer ||
      creatable.get(ata!) !== owner ||
      mint !== p.mint ||
      system !== SYSTEM_PROGRAM ||
      token !== TOKEN_PROGRAM
    ) {
      throw new SolanaTxMismatch(`transaction.instructions[${i}]`);
    }
    creatable.delete(ata!);
    i++;
  }
  const transferChecked = (leg: 'payment' | 'fee', destination: string, amount: bigint) => {
    if (i >= ixs.length) throw new SolanaTxMismatch(`transaction.${leg}`);
    if (programOf(i) !== TOKEN_PROGRAM) throw new SolanaTxMismatch(`transaction.${leg}`);
    const d = dataOf(i);
    if (d.length !== 10 || d[0] !== 12) throw new SolanaTxMismatch(`transaction.${leg}`);
    const [source, mint, dest, authority] = accountsOf(i, 4);
    if (source !== accounts.source) throw new SolanaTxMismatch(`transaction.${leg}.source`);
    if (mint !== p.mint) throw new SolanaTxMismatch(`transaction.${leg}.mint`);
    if (dest !== destination) throw new SolanaTxMismatch(`transaction.${leg}.destination`);
    if (authority !== p.wallet) throw new SolanaTxMismatch(`transaction.${leg}.authority`);
    if (u64le(d, 1) !== amount) throw new SolanaTxMismatch(`transaction.${leg}.amount`);
    if (d[9] !== p.decimals) throw new SolanaTxMismatch(`transaction.${leg}.decimals`);
    i++;
  };
  transferChecked('payment', accounts.deposit, p.amount);
  if (accounts.fee) transferChecked('fee', accounts.fee, p.fee);
  if (i !== ixs.length) throw new SolanaTxMismatch(`transaction.instructions[${i}]`);
  // No account the instructions do not use (nothing extra locked or charged).
  if (used.size !== keys.length) throw new SolanaTxMismatch('transaction.accounts');

  return {
    transaction: base64,
    blockhash: msg.lifetimeToken,
    shopperSignature: bs58.encode(shopperSig),
  };
}

/** Splits wire bytes into the signature slots and the message (null when malformed). */
function splitWire(base64: string): { sigs: Uint8Array[]; message: Uint8Array } | null {
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (bytes.length === 0 || Buffer.from(bytes).toString('base64') !== base64) return null;
  let count: number;
  let at: number;
  try {
    [count, at] = readCompactU16(bytes, 0);
  } catch {
    return null;
  }
  if (count < 1 || count > 8 || bytes.length <= at + 64 * count) return null;
  const sigs: Uint8Array[] = [];
  for (let k = 0; k < count; k++) sigs.push(bytes.slice(at + 64 * k, at + 64 * (k + 1)));
  return { sigs, message: bytes.slice(at + 64 * count) };
}

/** The blockhash a wire transaction names, without checking anything else (null if unreadable). */
export function transactionBlockhash(base64: string): string | null {
  const w = splitWire(base64);
  if (!w) return null;
  try {
    return getCompiledTransactionMessageDecoder().decode(w.message).lifetimeToken;
  } catch {
    return null;
  }
}

/**
 * Checks what the paymaster returned from `signTransaction`: the same message and the same
 * shopper signature as `submitted`, plus a valid fee-payer signature by `feePayer` in slot 0.
 * Returns that signature (base58): the transaction's id. Throws SolanaTxMismatch.
 */
export function feePayerSignature(submitted: string, signed: string, feePayer: string): string {
  const a = splitWire(submitted);
  const b = splitWire(signed);
  if (!a || !b || a.sigs.length !== 2 || b.sigs.length !== 2) {
    throw new SolanaTxMismatch('signed_transaction');
  }
  if (
    Buffer.compare(Buffer.from(a.message), Buffer.from(b.message)) !== 0 ||
    Buffer.compare(Buffer.from(a.sigs[1]!), Buffer.from(b.sigs[1]!)) !== 0
  ) {
    throw new SolanaTxMismatch('signed_transaction');
  }
  let ok = false;
  try {
    ok = ed25519.verify(
      b.sigs[0]!,
      b.message,
      getAddressEncoder().encode(address(feePayer)) as Uint8Array,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new SolanaTxMismatch('signed_transaction.fee_payer_signature');
  return bs58.encode(b.sigs[0]!);
}

/** Whether `s` is a base58 Solana address (32 bytes). */
export function isSolanaAddress(s: string): boolean {
  return isAddress(s);
}
