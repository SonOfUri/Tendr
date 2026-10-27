// ERC-4337 user operations for the Pimlico paymaster proxy (project 5a, spec §2.3 EVM item 3):
// parsing the RPC (unpacked v0.7 / v0.8) shape, the user-operation hash, and decoding the calls a
// smart account will make from its `callData`.
//
// Only call formats that can be decoded unambiguously are understood; anything else is refused
// (no sponsorship, the pay page falls back). Every ABI decoding must re-encode to the exact bytes
// given, so an account's own decoder can never read different calls from the same bytes.
import {
  AbiCoder,
  Interface,
  TypedDataEncoder,
  concat,
  keccak256,
  toBeHex,
  zeroPadValue,
} from 'ethers';
import { z } from 'zod';

/** EntryPoint v0.7 (lower-case). */
export const ENTRY_POINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032';
/** EntryPoint v0.8 (lower-case). */
export const ENTRY_POINT_V08 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';
/** The only entry points the proxy sponsors for (v0.6 user operations are refused). */
export const SUPPORTED_ENTRY_POINTS: readonly string[] = [ENTRY_POINT_V07, ENTRY_POINT_V08];

/**
 * Safe's canonical MultiSendCallOnly deployments (v1.3.0, v1.4.1): the only delegatecall target
 * accepted for a Safe batch. MultiSendCallOnly itself refuses nested delegatecalls. Confirm the
 * code at these addresses on each chain before go-live (README live checklist).
 */
export const SAFE_MULTISEND_CALL_ONLY: readonly string[] = [
  '0x40a2accbd92bca938b02010e17a5b8929b49130d',
  '0x9641d764fc13c8b624c04430c7356c1c7c8102e2',
];

/** A user operation the proxy cannot sponsor (shape, entry point, account format, calls). */
export class UserOpRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserOpRefused';
  }
}

const HEX = z
  .string()
  .max(40_002)
  .regex(/^0x([0-9a-fA-F]{2})*$/, 'must be 0x hex bytes');
const QTY = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'must be a 0x hex quantity');
const ADDR = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x address');

const UserOpSchema = z
  .object({
    sender: ADDR,
    nonce: QTY,
    factory: ADDR.nullish(),
    factoryData: HEX.nullish(),
    callData: HEX,
    callGasLimit: QTY.nullish(),
    verificationGasLimit: QTY.nullish(),
    preVerificationGas: QTY.nullish(),
    maxFeePerGas: QTY.nullish(),
    maxPriorityFeePerGas: QTY.nullish(),
    paymaster: ADDR.nullish(),
    paymasterVerificationGasLimit: QTY.nullish(),
    paymasterPostOpGasLimit: QTY.nullish(),
    paymasterData: HEX.nullish(),
    signature: HEX.nullish(),
    eip7702Auth: z.null().optional(),
  })
  .strict();

/** A v0.7/v0.8 user operation as sent over RPC (hex strings; gas fields may be absent in a stub). */
export type UserOp = z.infer<typeof UserOpSchema>;

/** Validates an RPC user operation; throws `UserOpRefused`. */
export function parseUserOp(raw: unknown): UserOp {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if ('initCode' in o || 'paymasterAndData' in o) {
      throw new UserOpRefused('EntryPoint v0.6 user operations are not supported');
    }
    if (o.eip7702Auth != null || 'authorization' in o) {
      throw new UserOpRefused('EIP-7702 authorizations are never sponsored');
    }
    if (typeof o.factory === 'string' && /^0x7702/i.test(o.factory)) {
      throw new UserOpRefused('EIP-7702 authorizations are never sponsored');
    }
  }
  const r = UserOpSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new UserOpRefused(`invalid user operation: ${i.path.join('.') || 'value'} ${i.message}`);
  }
  return r.data;
}

const big = (q: string | null | undefined) => (q ? BigInt(q) : 0n);
const u128 = (q: string | null | undefined) => zeroPadValue(toBeHex(big(q)), 16);

/** The packed fields the EntryPoint hashes. */
function packed(op: UserOp) {
  return {
    initCode: op.factory ? concat([op.factory, op.factoryData ?? '0x']) : '0x',
    accountGasLimits: concat([u128(op.verificationGasLimit), u128(op.callGasLimit)]),
    gasFees: concat([u128(op.maxPriorityFeePerGas), u128(op.maxFeePerGas)]),
    paymasterAndData: op.paymaster
      ? concat([
          op.paymaster,
          u128(op.paymasterVerificationGasLimit),
          u128(op.paymasterPostOpGasLimit),
          op.paymasterData ?? '0x',
        ])
      : '0x',
  };
}

const PACKED_USER_OP_TYPES = {
  PackedUserOperation: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
  ],
};

/** The user-operation hash (what the account signs and the bundler reports), lower-case hex. */
export function userOpHash(op: UserOp, entryPoint: string, chainId: number): string {
  const p = packed(op);
  const ep = entryPoint.toLowerCase();
  if (ep === ENTRY_POINT_V08) {
    return TypedDataEncoder.hash(
      { name: 'ERC4337', version: '1', chainId, verifyingContract: ep },
      PACKED_USER_OP_TYPES,
      {
        sender: op.sender,
        nonce: big(op.nonce),
        initCode: p.initCode,
        callData: op.callData,
        accountGasLimits: p.accountGasLimits,
        preVerificationGas: big(op.preVerificationGas),
        gasFees: p.gasFees,
        paymasterAndData: p.paymasterAndData,
      },
    ).toLowerCase();
  }
  if (ep !== ENTRY_POINT_V07) throw new UserOpRefused('unsupported entry point');
  const abi = AbiCoder.defaultAbiCoder();
  const inner = keccak256(
    abi.encode(
      ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
      [
        op.sender,
        big(op.nonce),
        keccak256(p.initCode),
        keccak256(op.callData),
        p.accountGasLimits,
        big(op.preVerificationGas),
        p.gasFees,
        keccak256(p.paymasterAndData),
      ],
    ),
  );
  return keccak256(abi.encode(['bytes32', 'address', 'uint256'], [inner, ep, chainId]));
}

/** The most the EntryPoint can charge for the operation (wei): every gas limit × maxFeePerGas. */
export function maxUserOpCostWei(op: UserOp): bigint {
  const gas =
    big(op.callGasLimit) +
    big(op.verificationGasLimit) +
    big(op.preVerificationGas) +
    big(op.paymasterVerificationGasLimit) +
    big(op.paymasterPostOpGasLimit);
  return gas * big(op.maxFeePerGas);
}

/** One call the account makes: target, native value, calldata (all lower-case). */
export interface AccountCall {
  to: string;
  value: bigint;
  data: string;
}

export type AccountFormat = 'erc7579' | 'coinbase' | 'safe';

const ACCOUNTS = new Interface([
  // ERC-7579 (Kernel v3, Nexus, Safe 7579 adapter, …)
  'function execute(bytes32 mode, bytes executionCalldata)',
  // Coinbase Smart Wallet (the single form is also SimpleAccount / LightAccount's `execute`)
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
  'function execute(address target, uint256 value, bytes data)',
  // Safe 4337 module
  'function executeUserOp(address to, uint256 value, bytes data, uint8 operation)',
  'function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)',
]);
const MULTISEND = new Interface(['function multiSend(bytes transactions)']);
const EXECUTIONS = 'tuple(address,uint256,bytes)[]';

const SEL = {
  erc7579Execute: '0xe9ae5c53',
  coinbaseBatch: '0x34fcd5be',
  execute: '0xb61d27f6',
  safeExec: '0x7bb37428',
  safeExecErr: '0x541d63c8',
  multiSend: '0x8d80ff0a',
} as const;

const notCanonical = () => new UserOpRefused('non-canonical call encoding');
const unknownFormat = () => new UserOpRefused('unknown smart-account call format');

function call(to: string, value: bigint, data: string): AccountCall {
  return { to: to.toLowerCase(), value, data: data.toLowerCase() };
}

/** Decodes `fn` from `data` and asserts `data` is exactly its canonical encoding. */
function decodeExact(iface: Interface, fn: string, data: string) {
  let args;
  try {
    args = iface.decodeFunctionData(fn, data);
  } catch {
    throw notCanonical();
  }
  if (iface.encodeFunctionData(fn, args).toLowerCase() !== data.toLowerCase()) throw notCanonical();
  return args;
}

function decodeExecutions(bytes: string): AccountCall[] {
  const abi = AbiCoder.defaultAbiCoder();
  let decoded;
  try {
    decoded = abi.decode([EXECUTIONS], bytes);
  } catch {
    throw notCanonical();
  }
  if (abi.encode([EXECUTIONS], decoded).toLowerCase() !== bytes.toLowerCase()) throw notCanonical();
  return (decoded[0] as [string, bigint, string][]).map(([t, v, d]) => call(t, v, d));
}

/** ERC-7579 `execute(mode, executionCalldata)`: only default-mode single or batch calls. */
function erc7579(data: string): AccountCall[] {
  const [mode, exec] = decodeExact(ACCOUNTS, 'execute(bytes32,bytes)', data) as unknown as [
    string,
    string,
  ];
  const m = mode.toLowerCase();
  // callType (byte 0): 0x00 single, 0x01 batch; execType (byte 1) 0x00 (revert on failure);
  // the rest (unused, mode selector, payload) all zero. Delegatecall / try mode: refused.
  if (m.slice(6) !== '0'.repeat(60) || m.slice(4, 6) !== '00') {
    throw new UserOpRefused('unsupported ERC-7579 execution mode');
  }
  const callType = m.slice(2, 4);
  if (callType === '01') return decodeExecutions(exec);
  if (callType !== '00') throw new UserOpRefused('unsupported ERC-7579 execution mode');
  const raw = exec.toLowerCase();
  // abi.encodePacked(target, value, callData)
  if (raw.length < 2 + 2 * 52) throw notCanonical();
  return [call('0x' + raw.slice(2, 42), BigInt('0x' + raw.slice(42, 106)), '0x' + raw.slice(106))];
}

/** Safe MultiSend packed transactions: `operation(1) to(20) value(32) length(32) data`. */
function multiSendCalls(data: string): AccountCall[] {
  const [txs] = decodeExact(MULTISEND, 'multiSend', data) as unknown as [string];
  const hex = txs.toLowerCase().slice(2);
  const out: AccountCall[] = [];
  let i = 0;
  while (i < hex.length) {
    if (hex.length - i < 2 * 85) throw notCanonical();
    const op = hex.slice(i, i + 2);
    const to = '0x' + hex.slice(i + 2, i + 42);
    const value = BigInt('0x' + hex.slice(i + 42, i + 106));
    const len = Number(BigInt('0x' + hex.slice(i + 106, i + 170)));
    const end = i + 170 + 2 * len;
    if (!Number.isSafeInteger(len) || end > hex.length) throw notCanonical();
    if (op !== '00') throw new UserOpRefused('delegatecall inside a Safe batch is refused');
    out.push(call(to, value, '0x' + hex.slice(i + 170, end)));
    i = end;
  }
  if (out.length === 0) throw notCanonical();
  return out;
}

function safe(fn: 'executeUserOp' | 'executeUserOpWithErrorString', data: string): AccountCall[] {
  const [to, value, inner, operation] = decodeExact(ACCOUNTS, fn, data) as unknown as [
    string,
    bigint,
    string,
    bigint,
  ];
  if (operation === 0n) return [call(to, value, inner)];
  if (
    operation !== 1n ||
    !SAFE_MULTISEND_CALL_ONLY.includes(to.toLowerCase()) ||
    value !== 0n ||
    inner.slice(0, 10).toLowerCase() !== SEL.multiSend
  ) {
    throw new UserOpRefused(
      'a Safe delegatecall is refused unless it is a MultiSendCallOnly batch',
    );
  }
  return multiSendCalls(inner);
}

/**
 * The calls a smart account makes for `callData`, in order. Throws `UserOpRefused` for an unknown
 * format, a non-default execution mode, any delegatecall (other than a Safe MultiSendCallOnly
 * batch) or a non-canonical encoding.
 */
export function decodeAccountCalls(callData: string): {
  format: AccountFormat;
  calls: AccountCall[];
} {
  const sel = callData.slice(0, 10).toLowerCase();
  switch (sel) {
    case SEL.erc7579Execute:
      return { format: 'erc7579', calls: erc7579(callData) };
    case SEL.coinbaseBatch: {
      const [cs] = decodeExact(ACCOUNTS, 'executeBatch', callData) as unknown as [
        [string, bigint, string][],
      ];
      return { format: 'coinbase', calls: cs.map(([t, v, d]) => call(t, v, d)) };
    }
    case SEL.execute: {
      const [t, v, d] = decodeExact(
        ACCOUNTS,
        'execute(address,uint256,bytes)',
        callData,
      ) as unknown as [string, bigint, string];
      return { format: 'coinbase', calls: [call(t, v, d)] };
    }
    case SEL.safeExec:
      return { format: 'safe', calls: safe('executeUserOp', callData) };
    case SEL.safeExecErr:
      return { format: 'safe', calls: safe('executeUserOpWithErrorString', callData) };
    default:
      throw unknownFormat();
  }
}
