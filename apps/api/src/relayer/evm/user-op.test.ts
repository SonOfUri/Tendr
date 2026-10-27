// ERC-4337 user operations: hashes (v0.7 / v0.8 vectors computed with viem's
// `getUserOperationHash`) and the smart-account call formats the paymaster proxy can decode.
import { AbiCoder, Interface, concat, toBeHex, zeroPadValue } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_POINT_V07,
  ENTRY_POINT_V08,
  SAFE_MULTISEND_CALL_ONLY,
  decodeAccountCalls,
  parseUserOp,
  userOpHash,
} from './user-op.js';

const OP = {
  sender: '0x1234567890123456789012345678901234567890',
  nonce: '0x5',
  factory: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  factoryData: '0xdeadbeef',
  callData: '0xe9ae5c53' + '00'.repeat(32),
  callGasLimit: toBeHex(100000n),
  verificationGasLimit: toBeHex(200000n),
  preVerificationGas: toBeHex(50000n),
  maxFeePerGas: toBeHex(3000000000n),
  maxPriorityFeePerGas: toBeHex(1000000000n),
  paymaster: '0x777777777777aec03fd955926dbf81597e66834c',
  paymasterVerificationGasLimit: toBeHex(60000n),
  paymasterPostOpGasLimit: '0x1',
  paymasterData: '0x0102030405',
  signature: '0x',
};

describe('userOpHash', () => {
  it('matches EntryPoint v0.7 and v0.8', () => {
    const op = parseUserOp(OP);
    expect(userOpHash(op, ENTRY_POINT_V07, 8453)).toBe(
      '0x31c16892caa75c9bb3e443cb3c07d650fcd23a9b6066f65f363e53c1347c3f01',
    );
    expect(userOpHash(op, ENTRY_POINT_V08, 8453)).toBe(
      '0x0711a1e45302cf4496fb2bb544de1692311991dc498b589f6b7dd06743dd3d42',
    );
    const bare = parseUserOp({
      ...OP,
      factory: undefined,
      factoryData: undefined,
      paymaster: null,
      paymasterVerificationGasLimit: undefined,
      paymasterPostOpGasLimit: undefined,
      paymasterData: undefined,
    });
    expect(userOpHash(bare, ENTRY_POINT_V07, 8453)).toBe(
      '0xc74bdb4e70416fd615cd0917cf101aaf89a1ce766ba41c9893453c715aa3cb39',
    );
  });
});

describe('parseUserOp', () => {
  it('refuses v0.6 fields, EIP-7702 authorizations and unknown fields', () => {
    expect(() => parseUserOp({ ...OP, initCode: '0x' })).toThrow(/v0\.6/);
    expect(() => parseUserOp({ ...OP, paymasterAndData: '0x' })).toThrow(/v0\.6/);
    expect(() =>
      parseUserOp({ ...OP, eip7702Auth: { address: OP.sender, chainId: '0x1' } }),
    ).toThrow(/7702/);
    expect(() => parseUserOp({ ...OP, factory: '0x7702' + '00'.repeat(18) })).toThrow(/7702/);
    expect(() => parseUserOp({ ...OP, extra: '0x' })).toThrow();
    expect(() => parseUserOp({ ...OP, sender: 'alice.near' })).toThrow();
    expect(parseUserOp({ ...OP, eip7702Auth: null }).sender).toBe(OP.sender);
  });
});

const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const erc20 = new Interface(['function transfer(address,uint256)']);
const transfer = (to: string, v: bigint) => erc20.encodeFunctionData('transfer', [to, v]);
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const calls = [
  { to: TOKEN, value: 0n, data: transfer(A, 1_000_000n) },
  { to: TOKEN, value: 0n, data: transfer(B, 48_000n) },
];
const abi = AbiCoder.defaultAbiCoder();
const EXEC_TUPLE = 'tuple(address,uint256,bytes)[]';
const accounts = new Interface([
  'function execute(bytes32 mode, bytes executionCalldata)',
  'function executeBatch((address,uint256,bytes)[] calls)',
  'function execute(address target, uint256 value, bytes data)',
  'function executeUserOp(address to, uint256 value, bytes data, uint8 operation)',
  'function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)',
  'function multiSend(bytes transactions)',
]);
const lower = (cs: { to: string; value: bigint; data: string }[]) =>
  cs.map((c) => ({ to: c.to.toLowerCase(), value: c.value, data: c.data.toLowerCase() }));

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const mode = (callType: number, execType = 0) =>
  '0x' + hex2(callType) + hex2(execType) + '00'.repeat(30);

function packedMultiSend(cs: { to: string; value: bigint; data: string }[], op = 0) {
  return concat(
    cs.map((c) =>
      concat([
        toBeHex(op, 1),
        c.to,
        zeroPadValue(toBeHex(c.value), 32),
        zeroPadValue(toBeHex((c.data.length - 2) / 2), 32),
        c.data,
      ]),
    ),
  );
}

describe('decodeAccountCalls', () => {
  it('ERC-7579 execute: batch and single', () => {
    const batch = accounts.encodeFunctionData('execute(bytes32,bytes)', [
      mode(1),
      abi.encode([EXEC_TUPLE], [calls.map((c) => [c.to, c.value, c.data])]),
    ]);
    expect(decodeAccountCalls(batch)).toEqual({ format: 'erc7579', calls: lower(calls) });
    const single = accounts.encodeFunctionData('execute(bytes32,bytes)', [
      mode(0),
      concat([calls[0]!.to, zeroPadValue('0x00', 32), calls[0]!.data]),
    ]);
    expect(decodeAccountCalls(single)).toEqual({ format: 'erc7579', calls: lower([calls[0]!]) });
  });

  it('ERC-7579: delegatecall, try mode or a non-default mode is refused', () => {
    const body = abi.encode([EXEC_TUPLE], [calls.map((c) => [c.to, c.value, c.data])]);
    for (const m of [mode(0xff), mode(1, 1), mode(1).slice(0, 65) + '1']) {
      const data = accounts.encodeFunctionData('execute(bytes32,bytes)', [m, body]);
      expect(() => decodeAccountCalls(data)).toThrow(/mode/);
    }
  });

  it('Coinbase Smart Wallet executeBatch and execute', () => {
    const batch = accounts.encodeFunctionData('executeBatch', [
      calls.map((c) => [c.to, c.value, c.data]),
    ]);
    expect(decodeAccountCalls(batch)).toEqual({ format: 'coinbase', calls: lower(calls) });
    const one = accounts.encodeFunctionData('execute(address,uint256,bytes)', [
      calls[0]!.to,
      0n,
      calls[0]!.data,
    ]);
    expect(decodeAccountCalls(one)).toEqual({ format: 'coinbase', calls: lower([calls[0]!]) });
  });

  it('Safe 4337 module: a single call, or a batch through MultiSendCallOnly', () => {
    for (const fn of ['executeUserOp', 'executeUserOpWithErrorString']) {
      const one = accounts.encodeFunctionData(fn, [calls[0]!.to, 0n, calls[0]!.data, 0]);
      expect(decodeAccountCalls(one)).toEqual({ format: 'safe', calls: lower([calls[0]!]) });
    }
    const ms = accounts.encodeFunctionData('multiSend', [packedMultiSend(calls)]);
    const batch = accounts.encodeFunctionData('executeUserOp', [
      SAFE_MULTISEND_CALL_ONLY[0]!,
      0n,
      ms,
      1,
    ]);
    expect(decodeAccountCalls(batch)).toEqual({ format: 'safe', calls: lower(calls) });
    // A delegatecall anywhere else, or a delegatecall inside the batch, is refused.
    const elsewhere = accounts.encodeFunctionData('executeUserOp', [A, 0n, ms, 1]);
    expect(() => decodeAccountCalls(elsewhere)).toThrow(/delegatecall/);
    const inner = accounts.encodeFunctionData('multiSend', [packedMultiSend(calls, 1)]);
    const nested = accounts.encodeFunctionData('executeUserOp', [
      SAFE_MULTISEND_CALL_ONLY[0]!,
      0n,
      inner,
      1,
    ]);
    expect(() => decodeAccountCalls(nested)).toThrow(/delegatecall/);
  });

  it('unknown selectors and non-canonical encodings are refused', () => {
    expect(() => decodeAccountCalls('0x12345678' + '00'.repeat(64))).toThrow(/format/);
    expect(() => decodeAccountCalls('0x')).toThrow(/format/);
    const batch = accounts.encodeFunctionData('executeBatch', [
      calls.map((c) => [c.to, c.value, c.data]),
    ]);
    // Trailing bytes after a valid encoding: not the canonical encoding.
    expect(() => decodeAccountCalls(batch + 'ff')).toThrow(/encoding/);
  });
});
