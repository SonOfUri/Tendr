// What an EVM shopper signs for a gasless payment, and how the relayer checks it before spending
// gas (project 5a, spec §2.3). Everything signed binds the 1Click deposit address, the exact
// payment amount, the fee and its recipient (Tendr's `gas-fees-evm` address) and a deadline no
// later than the quote's. Nothing grants an open-ended allowance.
//
//   eip3009  The token's own `TransferWithAuthorization`: one for the payment (to the deposit
//            address) and, when the shopper pays the fee, one for the fee (to the gas-fee
//            address), both with the same `validBefore`. The forwarder's
//            `payWithAuthorizations` executes both in one transaction.
//   permit   An EIP-2612 `Permit` to the forwarder for exactly amount + fee, plus the forwarder's
//            `TendrPayment`; `payWithPermit` checks both and does two `transferFrom`s.
//
// The relayer never takes a field from the request: it rebuilds every expected message from the
// quote, compares the signed messages field by field, and recovers each signature to the quote's
// `wallet_address`. Nonces are derived from the quote id, so a signature can only ever belong to
// one quote.
import {
  FORWARDER_DOMAIN_NAME,
  FORWARDER_DOMAIN_VERSION,
  TENDR_FORWARDER_ABI,
  TENDR_PAYMENT_TYPES,
} from '@tendr/contracts';
import { Interface, Signature, getAddress, id as keccakUtf8, verifyTypedData } from 'ethers';
import { AppError } from '../../lib/errors.js';
import type { EvmRelayMethod, GaslessToken } from './tokens.js';

export interface EvmPaymentContext {
  quoteId: string;
  chain: string;
  chainId: number;
  token: GaslessToken;
  method: EvmRelayMethod;
  /** The quote's `wallet_address`: the only accepted signer. */
  wallet: string;
  depositAddress: string;
  /** Payment amount (the quote's `amount_in`) and fee (`fee_amount`, 0 when sponsored), base units. */
  amount: bigint;
  fee: bigint;
  /** Tendr's `gas-fees-evm` address. */
  feeTo: string;
  forwarder: string;
  /** The quote deadline; every signed deadline is this, in whole seconds (rounded down). */
  deadline: Date;
  /** The token's EIP-2612 nonce for `wallet` (permit only). */
  permitNonce?: bigint;
}

export type SignKind = 'payment' | 'fee' | 'permit' | 'tendr_payment';

export interface TypedDataPayload {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  /** Includes `EIP712Domain`, as `eth_signTypedData_v4` expects. */
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  /** uint256 values as decimal strings. */
  message: Record<string, string>;
}

export interface ToSign {
  kind: SignKind;
  typed_data: TypedDataPayload;
}

export interface SignedPart {
  message: Record<string, unknown>;
  signature: string;
}

export type SignedParts = Partial<Record<SignKind, SignedPart>>;

const DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

const PERMIT = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

const FORWARDER = new Interface(TENDR_FORWARDER_ABI as unknown as string);

/** The signed deadline: the quote deadline in whole seconds, rounded down (never later). */
export function deadlineSeconds(d: Date): bigint {
  return BigInt(Math.floor(d.getTime() / 1000));
}

/** The nonce of one signed message: keccak256("tendr:gasless:<leg>:<quote id>"). */
export function gaslessNonce(quoteId: string, leg: 'payment' | 'fee' | 'tendr_payment'): string {
  return keccakUtf8(`tendr:gasless:${leg}:${quoteId}`);
}

const mismatch = (field: string) =>
  new AppError('GASLESS_PAYLOAD_MISMATCH', 'The signed payment does not match this quote', 409, {
    field,
  });

/** The kinds of signature a method needs (the fee leg only when the shopper pays a fee). */
export function requiredKinds(ctx: Pick<EvmPaymentContext, 'method' | 'fee'>): SignKind[] {
  if (ctx.method === 'eip3009') return ctx.fee > 0n ? ['payment', 'fee'] : ['payment'];
  return ['permit', 'tendr_payment'];
}

function tokenDomain(ctx: EvmPaymentContext) {
  return {
    name: ctx.token.domain.name,
    version: ctx.token.domain.version,
    chainId: ctx.chainId,
    verifyingContract: getAddress(ctx.token.address),
  };
}

/** Every message the shopper signs for this quote, in signing order. */
export function buildToSign(ctx: EvmPaymentContext): ToSign[] {
  const wallet = getAddress(ctx.wallet);
  const deadline = deadlineSeconds(ctx.deadline).toString();
  const out: ToSign[] = [];
  if (ctx.method === 'eip3009') {
    const leg = (kind: 'payment' | 'fee', to: string, value: bigint): ToSign => ({
      kind,
      typed_data: {
        domain: tokenDomain(ctx),
        types: {
          EIP712Domain: DOMAIN_TYPE,
          TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION,
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: wallet,
          to: getAddress(to),
          value: value.toString(),
          validAfter: '0',
          validBefore: deadline,
          nonce: gaslessNonce(ctx.quoteId, kind),
        },
      },
    });
    out.push(leg('payment', ctx.depositAddress, ctx.amount));
    if (ctx.fee > 0n) out.push(leg('fee', ctx.feeTo, ctx.fee));
    return out;
  }
  if (ctx.permitNonce === undefined) throw new Error('permit needs the token nonce');
  out.push({
    kind: 'permit',
    typed_data: {
      domain: tokenDomain(ctx),
      types: { EIP712Domain: DOMAIN_TYPE, Permit: PERMIT },
      primaryType: 'Permit',
      message: {
        owner: wallet,
        spender: getAddress(ctx.forwarder),
        value: (ctx.amount + ctx.fee).toString(),
        nonce: ctx.permitNonce.toString(),
        deadline,
      },
    },
  });
  out.push({
    kind: 'tendr_payment',
    typed_data: {
      domain: {
        name: FORWARDER_DOMAIN_NAME,
        version: FORWARDER_DOMAIN_VERSION,
        chainId: ctx.chainId,
        verifyingContract: getAddress(ctx.forwarder),
      },
      types: { EIP712Domain: DOMAIN_TYPE, ...TENDR_PAYMENT_TYPES },
      primaryType: 'TendrPayment',
      message: {
        token: getAddress(ctx.token.address),
        from: wallet,
        to: getAddress(ctx.depositAddress),
        amount: ctx.amount.toString(),
        fee: ctx.fee.toString(),
        feeTo: getAddress(ctx.feeTo),
        deadline,
        nonce: gaslessNonce(ctx.quoteId, 'tendr_payment'),
      },
    },
  });
  return out;
}

/** Field values compared as the chain sees them: addresses and hex case-insensitively, numbers by value. */
function normalise(type: string, v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== 'string') return null;
  if (type === 'address') return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
  if (type === 'bytes32') return /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null;
  if (type.startsWith('uint')) {
    try {
      return /^(0x[0-9a-fA-F]+|\d+)$/.test(v) ? BigInt(v).toString() : null;
    } catch {
      return null;
    }
  }
  return v;
}

interface Verified {
  kind: SignKind;
  r: string;
  s: string;
  v: number;
  serialized: string;
}

function verifyOne(
  ctx: EvmPaymentContext,
  expected: ToSign,
  given: SignedPart | undefined,
): Verified {
  const { kind, typed_data: td } = expected;
  if (!given) throw mismatch(kind);
  const fields = td.types[td.primaryType]!;
  const keys = Object.keys(given.message ?? {});
  if (keys.length !== fields.length || keys.some((k) => !fields.some((f) => f.name === k))) {
    throw mismatch(`${kind}.message`);
  }
  for (const f of fields) {
    if (normalise(f.type, given.message[f.name]) !== normalise(f.type, td.message[f.name])) {
      throw mismatch(`${kind}.${f.name}`);
    }
  }
  let sig: Signature;
  try {
    sig = Signature.from(given.signature);
  } catch {
    throw mismatch(`${kind}.signature`);
  }
  const types = Object.fromEntries(
    Object.entries(td.types).filter(([name]) => name !== 'EIP712Domain'),
  );
  let signer: string;
  try {
    signer = verifyTypedData(td.domain, types, td.message, sig);
  } catch {
    throw mismatch(`${kind}.signature`);
  }
  if (signer.toLowerCase() !== ctx.wallet.toLowerCase()) throw mismatch(`${kind}.signer`);
  return { kind, r: sig.r, s: sig.s, v: sig.v, serialized: sig.serialized };
}

/**
 * Checks the shopper's signed messages against the ones this quote requires (409
 * GASLESS_PAYLOAD_MISMATCH naming the first differing field) and returns the forwarder call to
 * relay. Extra or missing signatures are a mismatch too.
 */
export function verifySigned(
  ctx: EvmPaymentContext,
  signed: SignedParts,
): { to: string; data: string } {
  const expected = buildToSign(ctx);
  const extra = Object.keys(signed).find((k) => !expected.some((e) => e.kind === k));
  if (extra) throw mismatch(extra);
  const ok = expected.map((e) => verifyOne(ctx, e, signed[e.kind]));
  const by = (k: SignKind) => ok.find((x) => x.kind === k);
  const token = getAddress(ctx.token.address);
  const wallet = getAddress(ctx.wallet);
  const deadline = deadlineSeconds(ctx.deadline);

  if (ctx.method === 'eip3009') {
    const auth = (kind: 'payment' | 'fee', to: string, value: bigint) => {
      const s = by(kind)!;
      return {
        token,
        from: wallet,
        to: getAddress(to),
        value,
        validAfter: 0n,
        validBefore: deadline,
        nonce: gaslessNonce(ctx.quoteId, kind),
        v: s.v,
        r: s.r,
        s: s.s,
      };
    };
    const zero = '0x' + '0'.repeat(64);
    const emptyLeg = {
      token: '0x' + '0'.repeat(40),
      from: '0x' + '0'.repeat(40),
      to: '0x' + '0'.repeat(40),
      value: 0n,
      validAfter: 0n,
      validBefore: 0n,
      nonce: zero,
      v: 0,
      r: zero,
      s: zero,
    };
    const data = FORWARDER.encodeFunctionData('payWithAuthorizations', [
      auth('payment', ctx.depositAddress, ctx.amount),
      ctx.fee > 0n ? auth('fee', ctx.feeTo, ctx.fee) : emptyLeg,
    ]);
    return { to: getAddress(ctx.forwarder), data };
  }

  const permit = by('permit')!;
  const pay = by('tendr_payment')!;
  const data = FORWARDER.encodeFunctionData('payWithPermit', [
    {
      token,
      owner: wallet,
      value: ctx.amount + ctx.fee,
      deadline,
      v: permit.v,
      r: permit.r,
      s: permit.s,
    },
    {
      token,
      from: wallet,
      to: getAddress(ctx.depositAddress),
      amount: ctx.amount,
      fee: ctx.fee,
      feeTo: getAddress(ctx.feeTo),
      deadline,
      nonce: gaslessNonce(ctx.quoteId, 'tendr_payment'),
    },
    pay.serialized,
  ]);
  return { to: getAddress(ctx.forwarder), data };
}

/** `nonces(address)` calldata (EIP-2612), for reading the shopper's permit nonce. */
export function noncesCalldata(owner: string): string {
  return new Interface(['function nonces(address) view returns (uint256)']).encodeFunctionData(
    'nonces',
    [owner],
  );
}
