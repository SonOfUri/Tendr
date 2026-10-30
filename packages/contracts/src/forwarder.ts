// TendrForwarder (onchain/evm/src/TendrForwarder.sol): the EIP-712 domain and `TendrPayment` type
// the shopper signs for the permit (EVM) and approve (Tron) gasless paths, plus the contract ABI
// (generated from the Foundry build into forwarder-abi.ts by onchain/scripts/forwarder-abi.sh).
import { z } from 'zod';

export { TENDR_FORWARDER_ABI } from './forwarder-abi.js';

/** EIP-712 domain name and version, as set in the contract's constructor. */
export const FORWARDER_DOMAIN_NAME = 'TendrForwarder';
export const FORWARDER_DOMAIN_VERSION = '1';

/** One EIP-712 struct field. */
export interface TypedDataField {
  name: string;
  type: string;
}

/**
 * The `TendrPayment` EIP-712 types, in the contract's field order (ethers' `signTypedData` /
 * `TypedDataEncoder` shape: no `EIP712Domain` entry).
 */
export const TENDR_PAYMENT_TYPES: { TendrPayment: TypedDataField[] } = {
  TendrPayment: [
    { name: 'token', type: 'address' },
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' },
    { name: 'feeTo', type: 'address' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/** The encoded type string; `keccak256` of it is the contract's `TENDR_PAYMENT_TYPEHASH`. */
export const TENDR_PAYMENT_TYPE =
  'TendrPayment(address token,address from,address to,uint256 amount,uint256 fee,address feeTo,uint256 deadline,bytes32 nonce)';

/** The forwarder's EIP-712 domain. */
export interface ForwarderDomain {
  name: typeof FORWARDER_DOMAIN_NAME;
  version: typeof FORWARDER_DOMAIN_VERSION;
  chainId: bigint;
  verifyingContract: string;
}

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9]\d{0,77})$/;

/**
 * The forwarder's EIP-712 domain on a chain. On Tron (TIP-712) pass the Tron chain id (mainnet
 * 728126428) and the forwarder's address as 20-byte hex (the base58 address's `41` prefix
 * dropped, `0x` added), which is what the TVM's `address(this)` returns.
 */
export function forwarderDomain(chainId: number | bigint, address: string): ForwarderDomain {
  if (!HEX_ADDRESS_RE.test(address)) {
    throw new Error(`forwarderDomain: expected a 0x-prefixed 20-byte hex address, got ${address}`);
  }
  const id = BigInt(chainId);
  if (id <= 0n) throw new Error(`forwarderDomain: invalid chain id ${chainId}`);
  return {
    name: FORWARDER_DOMAIN_NAME,
    version: FORWARDER_DOMAIN_VERSION,
    chainId: id,
    verifyingContract: address,
  };
}

const AddressSchema = z.string().regex(HEX_ADDRESS_RE, 'must be a 0x-prefixed 20-byte hex address');
/** A uint256 as a decimal string in base units (never a float). */
const UintSchema = z.string().regex(UINT_RE, 'must be a non-negative integer decimal string');

/** A `TendrPayment` message as it crosses the API (amounts and deadline as decimal strings). */
export const TendrPaymentSchema = z.object({
  token: AddressSchema,
  from: AddressSchema,
  to: AddressSchema,
  amount: UintSchema,
  fee: UintSchema,
  feeTo: AddressSchema,
  deadline: UintSchema,
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex nonce'),
});
export type TendrPayment = z.infer<typeof TendrPaymentSchema>;
