// Gas-fee sweep transports (project 5a, Task 12): per chain family, what a gas-fee account holds,
// what one transfer costs, and the unsigned bytes of the one transfer a sweep sends. They never
// touch a key: signing is `signSweep` (fee-sweep-guard.ts), which decodes and checks the exact
// bytes built here first.
//
// What is swept, per family (the tokens shopper-paid fees are collected in):
//   EVM     the gasless allow-list (USDC) on each chain, and the chain's native coin
//   Solana  the gasless allow-list (USDC, USDT); SOL is left as the account's gas
//   NEAR    the gasless allow-list (USDC, USDT); NEAR is left as the account's gas
//   Tron    USDT; TRX is left as the account's gas
//
// Live mode only (ruling R12-a). Tests inject fake chains or fake nodes; nothing here reaches a
// real network in the test suite.
import {
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { Interface, Transaction } from 'ethers';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import { env } from '../env.js';
import { isNativeToken } from '../gas/fees.js';
import { relayerNearSender, type RelayerNearSender } from '../near/client.js';
import { NEAR_GASLESS_TOKENS } from '../near/tokens.js';
import {
  RELAYER_NEAR_MAX_STORAGE_DEPOSIT,
  TGAS,
  buildTransaction,
  functionCallAction,
} from '../near/tx.js';
import { EvmRpc } from '../relayer/evm/rpc.js';
import { EVM_CHAIN_IDS, EVM_GASLESS_TOKENS, evmTokenAddress } from '../relayer/evm/tokens.js';
import { spendableYocto } from '../relayer/near-meta.js';
import { SolanaRpc } from '../relayer/solana-clients.js';
import { SOLANA_GASLESS_TOKENS, associatedTokenAccount } from '../relayer/solana-tx.js';
import { tronApi } from '../relayer/tron-energy.js';
import { balanceOfParameter, encodeRaw, refBlockOf, tronToEvm } from '../relayer/tron-tx.js';
import bs58 from 'bs58';
import {
  SWEEP_MAX_EVM_GAS,
  sweepMaxFeePerGas,
  SWEEP_MAX_TRON_FEE_LIMIT_SUN,
  transferCalldata,
  type SignedSweep,
  type SweepFamily,
  type SweepTx,
} from './fee-sweep-guard.js';

/** A token a gas-fee account may hold and the sweep moves. */
export interface SweepToken {
  assetId: string;
  symbol: string;
  decimals: number;
  /** null: the chain's native coin; else the token contract (EVM 0x / Tron T… / NEAR id / mint). */
  contract: string | null;
}

/** One chain family's transport for the sweep (injected in tests). */
export interface SweepChain {
  family: SweepFamily;
  /** 1Click chains whose gas-fee account is swept. */
  chains(): string[];
  /** The tokens swept on `chain`, from the 1Click token list. */
  tokens(chain: string, list: Map<string, TokenInfo>): SweepToken[];
  /** `account`'s balance of `token` (base units). */
  balance(chain: string, account: string, token: SweepToken): Promise<bigint>;
  /** The native coin `account` can spend on fees (smallest unit). */
  nativeBalance(chain: string, account: string): Promise<bigint>;
  /** What one sweep transfer of `token` costs in the native coin, with headroom. */
  transferFee(chain: string, account: string, token: SweepToken): Promise<bigint>;
  /**
   * The native coin a native-coin sweep must leave behind (smallest unit): gas for future token
   * sweeps plus its own transfer. Only families that sweep their native coin implement it.
   */
  nativeReserve?(chain: string): Promise<bigint>;
  /** Readies the deposit address to receive (NEAR: `relayer-near` registers it on the token). */
  prepare?(chain: string, token: SweepToken, depositAddress: string): Promise<void>;
  /** The unsigned bytes of the one transfer `account` → `depositAddress` of `amount`. */
  build(
    chain: string,
    account: string,
    token: SweepToken,
    depositAddress: string,
    amount: bigint,
  ): Promise<SweepTx>;
  /** Broadcasts the signed transfer. */
  broadcast(chain: string, signed: SignedSweep): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Pure builders (the guard tests build valid transfers with these)
// ---------------------------------------------------------------------------------------------

/** An unsigned EIP-1559 transfer (0x `unsignedSerialized`). */
export function buildEvmSweepTx(p: {
  chain: string;
  nonce: number;
  token: string | null;
  to: string;
  amount: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): SweepTx {
  const chainId = EVM_CHAIN_IDS[p.chain];
  if (chainId === undefined) throw new Error(`not an EVM chain: ${p.chain}`);
  const t = Transaction.from({
    type: 2,
    chainId: BigInt(chainId),
    nonce: p.nonce,
    to: p.token ?? p.to,
    value: p.token ? 0n : p.amount,
    data: p.token ? transferCalldata(p.to, p.amount) : '0x',
    gasLimit: p.gasLimit,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
  });
  return { family: 'evm', unsigned: t.unsignedSerialized };
}

/** Gas a NEAR sweep `ft_transfer` attaches. */
export const NEAR_SWEEP_GAS = 15n * TGAS;

/** An unsigned NEAR `ft_transfer` (borsh Transaction) from an implicit account. */
export function buildNearSweepTx(p: {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  blockHash: Uint8Array;
  token: string;
  to: string;
  amount: bigint;
}): SweepTx {
  const tx = buildTransaction({
    signerId: p.signerId,
    publicKey: p.publicKey,
    nonce: p.nonce,
    receiverId: p.token,
    blockHash: p.blockHash,
    actions: [
      functionCallAction(
        'ft_transfer',
        { receiver_id: p.to, amount: p.amount.toString() },
        NEAR_SWEEP_GAS,
        1n,
      ),
    ],
  });
  return { family: 'near', transaction: tx.encode() };
}

/** An unsigned Tron TRC-20 `transfer` (`Transaction.raw` bytes). */
export function buildTronSweepTx(p: {
  blockId: string;
  now: number;
  owner: string;
  token: string;
  to: string;
  amount: bigint;
  feeLimit: bigint;
}): SweepTx {
  const data = Buffer.from(transferCalldata(tronToEvm(p.to), p.amount).slice(2), 'hex');
  const raw = encodeRaw({
    ref: refBlockOf(p.blockId),
    expiration: BigInt(p.now + 60_000),
    timestamp: BigInt(p.now),
    feeLimit: p.feeLimit,
    contract: { type: 'trigger', owner: p.owner, contract: p.token, data: Uint8Array.from(data) },
  });
  return { family: 'tron', raw };
}

/** An unsigned Solana sweep message (v0): [create deposit ATA] + TransferChecked. */
export async function buildSolanaSweepTx(p: {
  owner: string;
  mint: string;
  decimals: number;
  to: string;
  amount: bigint;
  blockhash: string;
  createDeposit: boolean;
}): Promise<SweepTx> {
  const owner = createNoopSigner(address(p.owner));
  const mint = address(p.mint);
  const deposit = address(await associatedTokenAccount(p.to, p.mint));
  const ixs: Instruction[] = [];
  if (p.createDeposit) {
    ixs.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: owner,
        ata: deposit,
        owner: address(p.to),
        mint,
      }),
    );
  }
  ixs.push(
    getTransferCheckedInstruction({
      source: address(await associatedTokenAccount(p.owner, p.mint)),
      mint,
      destination: deposit,
      authority: owner,
      amount: p.amount,
      decimals: p.decimals,
    }),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(p.owner), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash(p.blockhash), lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return { family: 'solana', message: Uint8Array.from(compileTransaction(message).messageBytes) };
}

// ---------------------------------------------------------------------------------------------
// Live transports
// ---------------------------------------------------------------------------------------------

const ERC20 = new Interface(['function balanceOf(address owner) view returns (uint256)']);

/** Headroom on a fee estimate (gas prices move; OP-stack chains add an L1 data fee). */
const FEE_HEADROOM = 2n;
/** Gas limits of the EVM sweep transfers. */
export const EVM_TOKEN_SWEEP_GAS = 200_000n;
export const EVM_NATIVE_SWEEP_GAS = 100_000n;
/** A native sweep keeps gas for this many token sweeps of this much gas each (R12-k). */
export const EVM_RESERVED_TOKEN_SWEEPS = 3n;
export const EVM_RESERVED_SWEEP_GAS = 400_000n;

export class LiveEvmSweepChain implements SweepChain {
  readonly family = 'evm' as const;
  constructor(private readonly rpc: (chain: string) => EvmRpc = (c) => EvmRpc.forChain(c)) {}

  chains(): string[] {
    return [...new Set(EVM_GASLESS_TOKENS.map((t) => t.chain))];
  }

  tokens(chain: string, list: Map<string, TokenInfo>): SweepToken[] {
    const out: SweepToken[] = [];
    for (const t of list.values()) {
      if (t.blockchain !== chain) continue;
      const contract = evmTokenAddress(t.assetId);
      if (contract && EVM_GASLESS_TOKENS.some((g) => g.chain === chain && g.address === contract)) {
        out.push({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, contract });
      } else if (isNativeToken(t)) {
        out.push({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, contract: null });
      }
    }
    // Tokens first, the native coin last: a run's token transfers spend the gas before it.
    return out.sort((a, b) => (a.contract === null ? 1 : 0) - (b.contract === null ? 1 : 0));
  }

  async balance(chain: string, account: string, token: SweepToken): Promise<bigint> {
    if (token.contract === null) return this.nativeBalance(chain, account);
    const r = await this.rpc(chain).call({
      to: token.contract,
      data: ERC20.encodeFunctionData('balanceOf', [account]),
    });
    return BigInt(r === '0x' ? 0 : r);
  }

  async nativeBalance(chain: string, account: string): Promise<bigint> {
    const r = await this.rpc(chain).request('eth_getBalance', [account, 'latest']);
    if (typeof r !== 'string' || !/^0x[0-9a-fA-F]+$/.test(r)) throw new Error('bad eth_getBalance');
    return BigInt(r);
  }

  /** The chain's fees, clamped to the sweep's fee cap (the guard refuses anything above it). */
  private async fees(chain: string) {
    const rpc = this.rpc(chain);
    const cap = sweepMaxFeePerGas(chain);
    const tip = await rpc.maxPriorityFeePerGas();
    const asked = (await rpc.baseFeePerGas()) * 2n + tip;
    const maxFeePerGas = asked < cap ? asked : cap;
    return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
  }

  /**
   * Ruling R12-k: a native sweep leaves gas for EVM_RESERVED_TOKEN_SWEEPS future token sweeps
   * (EVM_RESERVED_SWEEP_GAS each, at the fee cap) plus its own transfer, also at the cap. A token
   * sweep's `transferFee` (≤ 200k gas × 2 headroom × a fee ≤ the cap) is at most one of those.
   */
  async nativeReserve(chain: string): Promise<bigint> {
    const cap = sweepMaxFeePerGas(chain);
    return (EVM_RESERVED_TOKEN_SWEEPS * EVM_RESERVED_SWEEP_GAS + EVM_NATIVE_SWEEP_GAS) * cap;
  }

  private gasLimit(token: SweepToken): bigint {
    // Fixed, inside the guard's bound: a USDC transfer is ~65k (Arbitrum counts its L1 part in gas).
    return token.contract === null ? EVM_NATIVE_SWEEP_GAS : EVM_TOKEN_SWEEP_GAS;
  }

  async transferFee(chain: string, _account: string, token: SweepToken): Promise<bigint> {
    const { maxFeePerGas } = await this.fees(chain);
    return this.gasLimit(token) * maxFeePerGas * FEE_HEADROOM;
  }

  async build(
    chain: string,
    account: string,
    token: SweepToken,
    depositAddress: string,
    amount: bigint,
  ): Promise<SweepTx> {
    const rpc = this.rpc(chain);
    const nonce = await rpc.transactionCount(account, 'pending');
    const fees = await this.fees(chain);
    const gasLimit = this.gasLimit(token);
    if (gasLimit > SWEEP_MAX_EVM_GAS) throw new Error('gas limit above the sweep bound');
    return buildEvmSweepTx({
      chain,
      nonce: Number(nonce),
      token: token.contract,
      to: depositAddress,
      amount,
      gasLimit,
      ...fees,
    });
  }

  async broadcast(chain: string, signed: SignedSweep): Promise<void> {
    await this.rpc(chain).sendRawTransaction(signed.signed);
  }
}

/** What the NEAR transport needs from `relayer-near` (its RPC, and its guarded signer). */
export type NearSweepSender = Pick<RelayerNearSender, 'rpc' | 'signAndSend'>;

export class LiveNearSweepChain implements SweepChain {
  readonly family = 'near' as const;
  constructor(private readonly sender: () => NearSweepSender = () => relayerNearSender(true)) {}
  chains(): string[] {
    return ['near'];
  }
  tokens(_chain: string, list: Map<string, TokenInfo>): SweepToken[] {
    return NEAR_GASLESS_TOKENS.filter((t) => list.has(t.assetId)).map((t) => ({
      assetId: t.assetId,
      symbol: t.symbol,
      decimals: t.decimals,
      contract: t.contract,
    }));
  }
  private get rpc() {
    return this.sender().rpc;
  }
  async balance(_chain: string, account: string, token: SweepToken): Promise<bigint> {
    const r = await this.rpc.viewFunction<unknown>(token.contract!, 'ft_balance_of', {
      account_id: account,
    });
    return typeof r === 'string' && /^\d+$/.test(r) ? BigInt(r) : 0n;
  }
  async nativeBalance(_chain: string, account: string): Promise<bigint> {
    const a = await this.rpc.viewAccountOrNull(account);
    return a ? spendableYocto(a) : 0n;
  }
  async transferFee(): Promise<bigint> {
    // 15 Tgas at up to 1e9 yocto per gas (with headroom) plus the attached yoctoNEAR.
    return NEAR_SWEEP_GAS * 1_000_000_000n * FEE_HEADROOM + 1n;
  }
  async prepare(_chain: string, token: SweepToken, depositAddress: string): Promise<void> {
    const rpc = this.rpc;
    const registered =
      (await rpc.viewFunction<unknown>(token.contract!, 'storage_balance_of', {
        account_id: depositAddress,
      })) !== null;
    if (registered) return;
    const bounds = await rpc.viewFunction<{ min?: unknown }>(
      token.contract!,
      'storage_balance_bounds',
      {},
    );
    const min =
      typeof bounds?.min === 'string' && /^\d+$/.test(bounds.min) ? BigInt(bounds.min) : null;
    if (min === null || min > RELAYER_NEAR_MAX_STORAGE_DEPOSIT) {
      throw new Error('unexpected storage_balance_bounds');
    }
    // `relayer-near` may sign exactly this (registration-only, gasless token, capped deposit).
    const res = await this.sender().signAndSend(token.contract!, [
      functionCallAction(
        'storage_deposit',
        { account_id: depositAddress, registration_only: true },
        30n * TGAS,
        min,
      ),
    ]);
    if (res.topLevelStatus !== 'success') throw new Error('storage_deposit failed');
  }
  async build(
    _chain: string,
    account: string,
    token: SweepToken,
    depositAddress: string,
    amount: bigint,
  ): Promise<SweepTx> {
    const publicKey = Uint8Array.from(Buffer.from(account, 'hex'));
    const nonce = await this.rpc.accessKeyNonce(account, `ed25519:${bs58.encode(publicKey)}`);
    return buildNearSweepTx({
      signerId: account,
      publicKey,
      nonce: nonce + 1n,
      blockHash: await this.rpc.finalBlockHash(),
      token: token.contract!,
      to: depositAddress,
      amount,
    });
  }
  async broadcast(_chain: string, signed: SignedSweep): Promise<void> {
    const res = await this.rpc.sendTx(Buffer.from(signed.signed, 'base64'), signed.txHash);
    if (res.topLevelStatus !== 'success') throw new Error('ft_transfer failed on chain');
  }
}

/** Tron energy a USDT transfer to a fresh address can use (~130k), and the bandwidth burn. */
const TRON_SWEEP_ENERGY = 140_000n;
const TRON_SWEEP_BANDWIDTH_SUN = 350_000n;

export class LiveTronSweepChain implements SweepChain {
  readonly family = 'tron' as const;
  chains(): string[] {
    return ['tron'];
  }
  tokens(_chain: string, list: Map<string, TokenInfo>): SweepToken[] {
    return TRON_SWEEP_TOKENS.filter((t) => list.has(t.assetId)).map((t) => ({ ...t }));
  }
  async balance(_chain: string, account: string, token: SweepToken): Promise<bigint> {
    const r = await tronApi().constantCall(
      account,
      token.contract!,
      'balanceOf(address)',
      balanceOfParameter(account),
    );
    return BigInt(`0x${r.result || '0'}`);
  }
  async nativeBalance(_chain: string, account: string): Promise<bigint> {
    return tronTrxBalance(account);
  }
  async transferFee(): Promise<bigint> {
    const price = await tronApi().energyPrice();
    const fee = TRON_SWEEP_ENERGY * price + TRON_SWEEP_BANDWIDTH_SUN;
    return fee > SWEEP_MAX_TRON_FEE_LIMIT_SUN ? SWEEP_MAX_TRON_FEE_LIMIT_SUN : fee;
  }
  async build(
    _chain: string,
    account: string,
    token: SweepToken,
    depositAddress: string,
    amount: bigint,
  ): Promise<SweepTx> {
    const head = await tronApi().nowBlock(false);
    return buildTronSweepTx({
      blockId: head.id,
      now: Date.now(),
      owner: account,
      token: token.contract!,
      to: depositAddress,
      amount,
      feeLimit: SWEEP_MAX_TRON_FEE_LIMIT_SUN,
    });
  }
  async broadcast(_chain: string, signed: SignedSweep): Promise<void> {
    const r = await tronApi().broadcastHex(signed.signed);
    if (!r.ok) throw new Error(`tron broadcast refused: ${r.code}`);
  }
}

/** USDT-TRC20, as the gasless Tron list names it (kept here to avoid the relayer's graph). */
export const TRON_SWEEP_TOKENS: readonly SweepToken[] = [
  {
    assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    symbol: 'USDT',
    decimals: 6,
  },
];

/** A Tron account's TRX balance (sun), from `TRON_RPC_URL` `/wallet/getaccount`. */
export async function tronTrxBalance(
  account: string,
  fetchImpl: typeof fetch = (u, i) => fetch(u, i),
): Promise<bigint> {
  const res = await fetchImpl(`${env().TRON_RPC_URL}/wallet/getaccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: account, visible: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tron HTTP ${res.status}`);
  const body = (await res.json()) as { balance?: unknown };
  const b = body?.balance;
  return typeof b === 'number' && Number.isSafeInteger(b) && b >= 0 ? BigInt(b) : 0n;
}

/** Lamports for the signature and a new token account's rent (when the deposit has none). */
const SOLANA_SWEEP_FEE_LAMPORTS = 10_000n + 2_039_280n;

async function solanaCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(env().SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } };
  if (body?.error) throw new Error(`Solana RPC: ${String(body.error.message).slice(0, 200)}`);
  return body?.result ?? null;
}

export class LiveSolanaSweepChain implements SweepChain {
  readonly family = 'solana' as const;
  chains(): string[] {
    return ['sol'];
  }
  tokens(_chain: string, list: Map<string, TokenInfo>): SweepToken[] {
    return SOLANA_GASLESS_TOKENS.filter((t) => list.has(t.assetId)).map((t) => ({
      assetId: t.assetId,
      symbol: t.symbol,
      decimals: t.decimals,
      contract: t.mint,
    }));
  }
  async balance(_chain: string, account: string, token: SweepToken): Promise<bigint> {
    const ata = await associatedTokenAccount(account, token.contract!);
    try {
      const r = (await solanaCall('getTokenAccountBalance', [
        ata,
        { commitment: 'confirmed' },
      ])) as {
        value?: { amount?: unknown };
      } | null;
      const a = r?.value?.amount;
      return typeof a === 'string' && /^\d+$/.test(a) ? BigInt(a) : 0n;
    } catch {
      return 0n; // no token account: nothing collected yet
    }
  }
  async nativeBalance(_chain: string, account: string): Promise<bigint> {
    const r = (await solanaCall('getBalance', [account, { commitment: 'confirmed' }])) as {
      value?: unknown;
    } | null;
    return typeof r?.value === 'number' ? BigInt(r.value) : 0n;
  }
  async transferFee(): Promise<bigint> {
    return SOLANA_SWEEP_FEE_LAMPORTS;
  }
  async build(
    _chain: string,
    account: string,
    token: SweepToken,
    depositAddress: string,
    amount: bigint,
  ): Promise<SweepTx> {
    const [exists] = await new SolanaRpc().accountsExist([
      await associatedTokenAccount(depositAddress, token.contract!),
    ]);
    const r = (await solanaCall('getLatestBlockhash', [{ commitment: 'confirmed' }])) as {
      value?: { blockhash?: unknown };
    } | null;
    const blockhash = r?.value?.blockhash;
    if (typeof blockhash !== 'string') throw new Error('no blockhash');
    return buildSolanaSweepTx({
      owner: account,
      mint: token.contract!,
      decimals: token.decimals,
      to: depositAddress,
      amount,
      blockhash,
      createDeposit: !exists,
    });
  }
  async broadcast(_chain: string, signed: SignedSweep): Promise<void> {
    await new SolanaRpc().sendTransaction(signed.signed);
  }
}

/** The live transports, one per family. */
export function liveSweepChains(): SweepChain[] {
  return [
    new LiveEvmSweepChain(),
    new LiveSolanaSweepChain(),
    new LiveNearSweepChain(),
    new LiveTronSweepChain(),
  ];
}
