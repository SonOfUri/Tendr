// What an integrator hook call is, exactly, and the check every signer makes before signing one
// (project 5a, Task 11, ruling T11-b).
//
// A hook call is fully determined by Tendr's own records: the hook call row, its session (where
// the payment settled: `recipient` on `dest_chain`, pinned at session creation from the
// integrator's approved settlement destination) and its settled payment (amount out, settlement
// transaction). `expectedHookCall` rebuilds it from those records; `assertHookTransaction` refuses
// any transaction that is not exactly that call. `relayer-evm` (EvmSender.send) and `relayer-near`
// (RelayerNearSender.signHook) run the check right before the key vault signs, so a bug or a
// tampered caller can only ever notify the session's own contract, with the session's own data.
//
//   EVM   onTendrDeposit(bytes32 paymentId, bytes32 sessionId, bytes hookData, address token,
//                        uint256 amount, bytes32 txHash)
//         paymentId / sessionId: the Tendr id's UTF-8 bytes, right-padded (`pay_…`, `ses_…`);
//         hookData: the session's `hook_data` as JSON (UTF-8); token: the settlement token
//         (address(0) for the chain's native coin); txHash: the settlement transaction.
//   NEAR  on_tendr_deposit({ payment_id, session_id, hook_data, token, amount, tx_hash }), all
//         strings: hook_data is the same JSON text, amount a U128 decimal string.
import { Interface, ZeroAddress, encodeBytes32String } from 'ethers';
import { evmTokenAddress } from '../relayer/evm/tokens.js';
import { prisma } from '../lib/prisma.js';
import { NEAR_HOOK_ATTACHED_GAS, NEAR_HOOK_METHOD } from '../near/tx.js';

export { NEAR_HOOK_ATTACHED_GAS, NEAR_HOOK_METHOD };

/** `relayer_transactions.purpose` of a hook call; `ref_id` is the hook call id. */
export const INTEGRATOR_HOOK_PURPOSE = 'integrator_hook';

/** The EVM hook interface (published with the reference receiver). */
export const ON_TENDR_DEPOSIT_ABI = [
  'function onTendrDeposit(bytes32 paymentId, bytes32 sessionId, bytes hookData, address token, uint256 amount, bytes32 txHash)',
] as const;
const IFACE = new Interface(ON_TENDR_DEPOSIT_ABI);
const SELECTOR = IFACE.getFunction('onTendrDeposit')!.selector;

/** The hook's arguments, as the NEAR call takes them (the EVM call encodes the same values). */
export interface HookArgs {
  payment_id: string;
  session_id: string;
  hook_data: string;
  token: string;
  amount: string;
  tx_hash: string;
}
const HOOK_ARG_KEYS = ['amount', 'hook_data', 'payment_id', 'session_id', 'token', 'tx_hash'];

export interface ExpectedHookCall {
  hookCallId: string;
  livemode: boolean;
  chain: string;
  family: 'evm' | 'near';
  /** The contract called: the session's settlement destination. */
  to: string;
  args: HookArgs;
  /** EVM calldata; null on NEAR. */
  data: string | null;
}

/** Why a hook call cannot be built or signed (never retried into success by itself). */
export class HookRefused extends Error {
  constructor(message: string) {
    super(`hook call refused: ${message}`);
    this.name = 'HookRefused';
  }
}

/** The EVM calldata of `onTendrDeposit` for `a`. */
export function encodeOnTendrDeposit(a: HookArgs): string {
  return IFACE.encodeFunctionData('onTendrDeposit', [
    encodeBytes32String(a.payment_id),
    encodeBytes32String(a.session_id),
    new TextEncoder().encode(a.hook_data),
    a.token,
    BigInt(a.amount),
    a.tx_hash,
  ]);
}

/** Whether EVM calldata calls `onTendrDeposit` (only ever sent as an integrator hook). */
export function isOnTendrDepositCall(data: string): boolean {
  return data.slice(0, 10).toLowerCase() === SELECTOR;
}

const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_NATIVE = /^nep141:[a-z0-9]+\.omft\.near$/;

/** The settlement token as the contract sees it, from the session's 1Click asset id. */
function tokenOf(family: 'evm' | 'near', assetId: string): string {
  if (family === 'evm') {
    const address = evmTokenAddress(assetId);
    if (address) return address;
    if (EVM_NATIVE.test(assetId)) return ZeroAddress;
    throw new HookRefused(`unknown settlement token ${assetId}`);
  }
  const m = /^nep141:(.+)$/.exec(assetId);
  if (!m) throw new HookRefused(`unknown settlement token ${assetId}`);
  return m[1]!;
}

/**
 * The hook call the records give for `hookCallId`. Throws HookRefused when the records do not
 * allow one: the store is no longer an integrator, the session has no hook delivery, the row's
 * target or chain differ from where the session settled, the payment is not settled, or the
 * settlement token / transaction is unknown.
 */
export async function expectedHookCall(hookCallId: string): Promise<ExpectedHookCall> {
  const h = await prisma.hookCall.findUnique({
    where: { id: hookCallId },
    include: {
      merchant: { select: { kind: true } },
      session: {
        select: {
          id: true,
          delivery: true,
          destChain: true,
          destAsset: true,
          recipient: true,
          recipientType: true,
        },
      },
      payment: { select: { id: true, settledAt: true, amountOut: true, settleTx: true } },
    },
  });
  if (!h) throw new HookRefused(`no hook call ${hookCallId}`);
  const { session: s, payment: p } = h;
  if (h.merchant.kind !== 'integrator') throw new HookRefused('the store is not an integrator');
  if (s.delivery !== 'HOOK' || s.recipientType !== 'DESTINATION_CHAIN') {
    throw new HookRefused('the session has no hook delivery');
  }
  const family = s.destChain === 'near' ? 'near' : 'evm';
  const same =
    family === 'evm'
      ? h.targetContract.toLowerCase() === s.recipient.toLowerCase()
      : h.targetContract === s.recipient;
  if (!same || h.chain !== s.destChain) {
    throw new HookRefused('the target is not the session settlement contract');
  }
  if (!p.settledAt) throw new HookRefused('the payment is not settled');
  const amount = p.amountOut ? p.amountOut.toFixed(0) : '0';
  if (amount === '0') throw new HookRefused('the settled amount is unknown');
  const txHash = p.settleTx ?? '';
  if (!(family === 'evm' ? EVM_TX_HASH : NEAR_TX_HASH).test(txHash)) {
    throw new HookRefused('the settlement transaction is unknown');
  }
  const args: HookArgs = {
    payment_id: p.id,
    session_id: s.id,
    hook_data: JSON.stringify(h.hookData),
    token: tokenOf(family, s.destAsset),
    amount,
    tx_hash: txHash,
  };
  return {
    hookCallId: h.id,
    livemode: h.livemode,
    chain: s.destChain,
    family,
    to: s.recipient,
    args,
    data: family === 'evm' ? encodeOnTendrDeposit(args) : null,
  };
}

export type HookTransactionCheck = { hookCallId: string; chain: string } & (
  { to: string; data: string } | { receiverId: string; args: Record<string, unknown> }
);

/**
 * Refuses (HookRefused) any transaction that is not exactly the hook call the records give for
 * `hookCallId`, or one for a call that already succeeded. Run by the signers themselves.
 */
export async function assertHookTransaction(p: HookTransactionCheck): Promise<void> {
  const expected = await expectedHookCall(p.hookCallId);
  const row = await prisma.hookCall.findUniqueOrThrow({
    where: { id: p.hookCallId },
    select: { status: true },
  });
  if (row.status === 'confirmed') throw new HookRefused('the call already succeeded');
  if (p.chain !== expected.chain) throw new HookRefused(`chain ${p.chain}`);
  if ('data' in p) {
    if (expected.family !== 'evm') throw new HookRefused('not an EVM hook');
    if (p.to.toLowerCase() !== expected.to.toLowerCase()) {
      throw new HookRefused('the target is not the session settlement contract');
    }
    if (p.data.toLowerCase() !== expected.data!.toLowerCase()) {
      throw new HookRefused('the calldata differs from the records');
    }
    return;
  }
  if (expected.family !== 'near') throw new HookRefused('not a NEAR hook');
  if (p.receiverId !== expected.to) {
    throw new HookRefused('the receiver is not the session settlement contract');
  }
  const keys = Object.keys(p.args).sort();
  if (
    keys.join(',') !== HOOK_ARG_KEYS.join(',') ||
    HOOK_ARG_KEYS.some((k) => p.args[k] !== expected.args[k as keyof HookArgs])
  ) {
    throw new HookRefused('the arguments differ from the records');
  }
}
