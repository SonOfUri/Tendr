// EVM gasless signing (spec §2.3): EIP-3009 `TransferWithAuthorization`, EIP-2612 `permit` plus
// a `TendrPayment` for the forwarder, or EIP-5792 `wallet_sendCalls` with the quote's paymaster
// URL. Every typed-data message and every call is rebuilt from the quote and compared field by
// field before the wallet is asked anything; the forwarder (the only spender a permit may name)
// and the paymaster URL's origin are pinned in the page's config, never taken from the payload.
// A wallet is never asked to delegate itself (EIP-7702) and no allowance outlives the payment.
import {
  TEST_PAYMENT_DOMAIN_NAME,
  TEST_PAYMENT_DOMAIN_VERSION,
  TEST_VERIFYING_CONTRACT,
  FORWARDER_DOMAIN_NAME,
  FORWARDER_DOMAIN_VERSION,
  TENDR_PAYMENT_TYPES,
} from '@tendr/contracts';
import { networkName } from '@/lib/checkout/format';
import { WalletError, afterSignError, toWalletError } from '../errors';
import { encodeErc20Transfer, ensureEvmChain, type Eip1193 } from '../evm';
import type { PayTarget } from '../index';
import {
  assertFeeRecipient,
  deadlineSeconds,
  gaslessNonce,
  mismatch,
  uintOf,
  type GaslessExpectation,
  type GaslessMethod,
  type GaslessSigner,
  type PreparePayload,
  type SignResult,
  type SignedPart,
} from './index';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = '0x' + '0'.repeat(40);
/** A delegated EOA (EIP-7702 designator, set by the wallet itself): still signs with its key. */
const DELEGATION_DESIGNATOR = /^0xef0100[0-9a-fA-F]{40}$/;
const PAYMASTER_TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

export type Field = { name: string; type: string };

export const DOMAIN_TYPE: Field[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const TRANSFER_WITH_AUTHORIZATION: Field[] = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];
const PERMIT: Field[] = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Field[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const sameAddr = (a: unknown, b: string) =>
  typeof a === 'string' && ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase();

const sameFields = (a: unknown, b: Field[]) =>
  Array.isArray(a) &&
  a.length === b.length &&
  a.every(
    (f, i) =>
      typeof f === 'object' &&
      f !== null &&
      Object.keys(f).length === 2 &&
      (f as Field).name === b[i]!.name &&
      (f as Field).type === b[i]!.type,
  );

/** The typed data's shape: exactly this primary type, these fields and this domain. */
export function checkShape(
  kind: string,
  raw: unknown,
  primary: string,
  fields: Field[],
  domain: {
    name?: string;
    version?: string;
    chainId: number;
    verifyingContract: string;
    /** A name the domain must not have (live: the test-mode domain). */
    notName?: string;
  },
): TypedData {
  const td = raw as TypedData | null;
  if (!td || typeof td !== 'object') throw mismatch(kind);
  if (td.primaryType !== primary) throw mismatch(`${kind}.primaryType`);
  const types = td.types ?? {};
  if (
    Object.keys(types).length !== 2 ||
    !sameFields(types.EIP712Domain, DOMAIN_TYPE) ||
    !sameFields(types[primary], fields)
  ) {
    throw mismatch(`${kind}.types`);
  }
  const d = td.domain ?? {};
  if (
    Object.keys(d).length !== 4 ||
    typeof d.name !== 'string' ||
    typeof d.version !== 'string' ||
    (domain.name !== undefined && d.name !== domain.name) ||
    (domain.version !== undefined && d.version !== domain.version) ||
    (domain.notName !== undefined && d.name === domain.notName) ||
    String(d.chainId) !== String(domain.chainId) ||
    !sameAddr(d.verifyingContract, domain.verifyingContract)
  ) {
    throw mismatch(`${kind}.domain`);
  }
  const m = td.message;
  if (!m || typeof m !== 'object') throw mismatch(`${kind}.message`);
  const keys = Object.keys(m);
  if (keys.length !== fields.length || keys.some((k) => !fields.some((f) => f.name === k))) {
    throw mismatch(`${kind}.message`);
  }
  for (const f of fields) {
    const v = m[f.name];
    const ok =
      f.type === 'address'
        ? typeof v === 'string' && ADDRESS.test(v)
        : f.type === 'bytes32'
          ? typeof v === 'string' && BYTES32.test(v)
          : (() => {
              try {
                uintOf(v, f.name);
                return true;
              } catch {
                return false;
              }
            })();
    if (!ok) throw mismatch(`${kind}.${f.name}`);
  }
  return td;
}

const expectKinds = (p: PreparePayload, kinds: string[]) => {
  if (p.to_sign.length !== kinds.length || p.to_sign.some((t, i) => !t || t.kind !== kinds[i])) {
    throw mismatch('to_sign');
  }
};

/**
 * A fee recipient: exactly Tendr's gas-fee account (ruling T10-g), and never the deposit address,
 * the shopper's own wallet or the zero address. A sponsored payload's `feeTo` (fee 0) is checked
 * whenever the recipient is known.
 */
function checkFeeTo(kind: string, field: string, v: unknown, e: GaslessExpectation) {
  if (
    typeof v !== 'string' ||
    sameAddr(v, e.depositAddress) ||
    sameAddr(v, e.wallet) ||
    sameAddr(v, ZERO)
  ) {
    throw mismatch(`${kind}.${field}`);
  }
  if (e.fee > 0n || e.feeRecipient !== null) assertFeeRecipient(e, v, `${kind}.${field}`);
}

/**
 * The domains a payload must use (ruling T10-f): live, the token's own and the forwarder's, never
 * the test name; test mode, the test domain at the code-less sentinel for every message.
 */
function domainsFor(e: GaslessExpectation, forwarder: string) {
  const chainId = e.target.chainId!;
  if (!e.livemode) {
    const test = {
      name: TEST_PAYMENT_DOMAIN_NAME,
      version: TEST_PAYMENT_DOMAIN_VERSION,
      chainId,
      verifyingContract: TEST_VERIFYING_CONTRACT,
    };
    return { token: test, forwarder: test };
  }
  return {
    token: { chainId, verifyingContract: e.target.contract!, notName: TEST_PAYMENT_DOMAIN_NAME },
    forwarder: {
      name: FORWARDER_DOMAIN_NAME,
      version: FORWARDER_DOMAIN_VERSION,
      chainId,
      verifyingContract: forwarder,
    },
  };
}

/**
 * The typed data to sign for an eip3009 / permit payload, each message checked against the quote.
 * Throws GaslessMismatchError naming the first differing field.
 */
export function checkEvmTypedData(
  p: PreparePayload,
  e: GaslessExpectation,
  forwarder: string,
): { kind: string; typed_data: TypedData }[] {
  const chainId = e.target.chainId!;
  const token = e.target.contract!;
  const latest = deadlineSeconds(e.deadline);
  const notLater = (kind: string, field: string, v: unknown) => {
    const s = uintOf(v, `${kind}.${field}`);
    if (s === 0n || s > latest) throw mismatch(`${kind}.${field}`);
    return s;
  };
  const domains = domainsFor(e, forwarder);
  const tokenDomain = domains.token;

  if (e.method === 'eip3009') {
    const kinds = e.fee > 0n ? ['payment', 'fee'] : ['payment'];
    expectKinds(p, kinds);
    const out = kinds.map((kind, i) => {
      const td = checkShape(
        kind,
        p.to_sign[i]!.typed_data,
        'TransferWithAuthorization',
        TRANSFER_WITH_AUTHORIZATION,
        tokenDomain,
      );
      const m = td.message;
      if (!sameAddr(m.from, e.wallet)) throw mismatch(`${kind}.from`);
      if (kind === 'payment') {
        if (!sameAddr(m.to, e.depositAddress)) throw mismatch('payment.to');
        if (uintOf(m.value, 'payment.value') !== e.amount) throw mismatch('payment.value');
      } else {
        checkFeeTo(kind, 'to', m.to, e);
        if (uintOf(m.value, 'fee.value') !== e.fee) throw mismatch('fee.value');
      }
      if (uintOf(m.validAfter, `${kind}.validAfter`) !== 0n) throw mismatch(`${kind}.validAfter`);
      // One nonce per quote and leg: a re-sign can never make a second executable authorization.
      if (String(m.nonce).toLowerCase() !== gaslessNonce(e.quoteId, kind as 'payment' | 'fee')) {
        throw mismatch(`${kind}.nonce`);
      }
      notLater(kind, 'validBefore', m.validBefore);
      return { kind, typed_data: td };
    });
    if (
      out.length === 2 &&
      String(out[0]!.typed_data.message.validBefore) !==
        String(out[1]!.typed_data.message.validBefore)
    ) {
      throw mismatch('fee.validBefore');
    }
    if (
      out.length === 2 &&
      String(out[0]!.typed_data.message.nonce).toLowerCase() ===
        String(out[1]!.typed_data.message.nonce).toLowerCase()
    ) {
      throw mismatch('fee.nonce');
    }
    return out;
  }

  if (e.method === 'permit') {
    expectKinds(p, ['permit', 'tendr_payment']);
    const permit = checkShape('permit', p.to_sign[0]!.typed_data, 'Permit', PERMIT, tokenDomain);
    const pm = permit.message;
    if (!sameAddr(pm.owner, e.wallet)) throw mismatch('permit.owner');
    // The only spender ever approved: Tendr's forwarder, for exactly amount + fee.
    if (!sameAddr(pm.spender, forwarder)) throw mismatch('permit.spender');
    if (uintOf(pm.value, 'permit.value') !== e.amount + e.fee) throw mismatch('permit.value');
    notLater('permit', 'deadline', pm.deadline);

    const pay = checkShape(
      'tendr_payment',
      p.to_sign[1]!.typed_data,
      'TendrPayment',
      TENDR_PAYMENT_TYPES.TendrPayment,
      domains.forwarder,
    );
    const m = pay.message;
    if (!sameAddr(m.token, token)) throw mismatch('tendr_payment.token');
    if (!sameAddr(m.from, e.wallet)) throw mismatch('tendr_payment.from');
    if (!sameAddr(m.to, e.depositAddress)) throw mismatch('tendr_payment.to');
    if (uintOf(m.amount, 'tendr_payment.amount') !== e.amount)
      throw mismatch('tendr_payment.amount');
    if (uintOf(m.fee, 'tendr_payment.fee') !== e.fee) throw mismatch('tendr_payment.fee');
    checkFeeTo('tendr_payment', 'feeTo', m.feeTo, e);
    notLater('tendr_payment', 'deadline', m.deadline);
    if (String(m.nonce).toLowerCase() !== gaslessNonce(e.quoteId, 'tendr_payment')) {
      throw mismatch('tendr_payment.nonce');
    }
    return [
      { kind: 'permit', typed_data: permit },
      { kind: 'tendr_payment', typed_data: pay },
    ];
  }
  throw mismatch('method');
}

/** The calls a paymaster payload batches: exactly the payment transfer (and the fee transfer). */
export function checkPaymasterCalls(
  p: PreparePayload,
  e: GaslessExpectation,
  paymasterUrlPrefix: string,
): void {
  // Test mode never uses the paymaster: the smart wallet would send a real operation (T10-f).
  if (!e.livemode) throw mismatch('method');
  const token = e.target.contract!;
  const calls = p.calls;
  const want = [encodeErc20Transfer(e.depositAddress, e.amount)];
  if (!Array.isArray(calls) || p.to_sign.length !== 0) throw mismatch('calls');
  if (e.fee > 0n) {
    const feeData = calls[1]?.data;
    // The fee recipient: whoever the second transfer names, never the deposit or the wallet.
    const feeTo = typeof feeData === 'string' ? '0x' + feeData.slice(34, 74) : '';
    if (!ADDRESS.test(feeTo)) throw mismatch('calls');
    checkFeeTo('calls', '1', feeTo, e);
    want.push(encodeErc20Transfer(feeTo, e.fee));
  }
  if (calls.length !== want.length) throw mismatch('calls');
  calls.forEach((c, i) => {
    let value: bigint;
    try {
      value = BigInt(c?.value ?? 'x');
    } catch {
      throw mismatch('calls');
    }
    if (
      !c ||
      Object.keys(c).length !== 3 ||
      !sameAddr(c.to, token) ||
      value !== 0n ||
      typeof c.data !== 'string' ||
      c.data.toLowerCase() !== want[i]!.toLowerCase()
    ) {
      throw mismatch('calls');
    }
  });
  const url = p.paymaster_url;
  if (
    typeof url !== 'string' ||
    !url.startsWith(paymasterUrlPrefix) ||
    !PAYMASTER_TOKEN.test(url.slice(paymasterUrlPrefix.length))
  ) {
    throw mismatch('paymaster_url');
  }
}

export interface EvmGaslessDeps {
  provider(): Eip1193 | undefined;
  /** The connected account. */
  address(): string | null;
  /** Tendr's forwarder (the page's config): the only spender a permit may approve. */
  forwarder: string;
  /** The API's per-quote paymaster URLs start with this. */
  paymasterUrlPrefix: string;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a sent batch's receipt before calling it possibly sent. */
  callsTimeoutMs?: number;
}

const hexChain = (id: number) => '0x' + id.toString(16);

function paymasterSupported(caps: unknown, chainId: number): boolean {
  if (!caps || typeof caps !== 'object') return false;
  const c = caps as Record<string, { paymasterService?: { supported?: unknown } } | undefined>;
  const forChain = c[hexChain(chainId)] ?? c[String(chainId)];
  return forChain?.paymasterService?.supported === true;
}

export function createEvmGasless(target: PayTarget, deps: EvmGaslessDeps): GaslessSigner {
  if (target.family !== 'evm' || target.chainId === undefined) {
    throw new WalletError('failed', { detail: 'not an EVM asset' });
  }
  const chainId = target.chainId;
  const chainHex = hexChain(chainId);
  const network = networkName(target.blockchain);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const connected = () => {
    const provider = deps.provider();
    const address = deps.address();
    if (!provider || !address) throw new WalletError('failed', { detail: 'not connected' });
    return { provider, address };
  };

  /** On the quote's chain, and still the account the quote was made for. */
  async function ready(provider: Eip1193, address: string) {
    await ensureEvmChain(provider, chainId, network);
    const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => null);
    const current = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof current !== 'string' || !ADDRESS.test(current)) {
      throw new WalletError('failed', { detail: 'no account' });
    }
    if (current.toLowerCase() !== address.toLowerCase()) {
      throw new WalletError('account_changed', { address: current });
    }
  }

  async function waitForCalls(provider: Eip1193, id: string): Promise<SignResult> {
    const deadline = Date.now() + (deps.callsTimeoutMs ?? 120_000);
    for (;;) {
      let st: { status?: unknown; receipts?: { transactionHash?: unknown; status?: unknown }[] };
      try {
        st = (await provider.request({
          method: 'wallet_getCallsStatus',
          params: [id],
        })) as typeof st;
      } catch {
        // The wallet sent the batch but cannot report on it: possibly sent (C32).
        return { kind: 'wallet_sent', txHash: null, state: 'uncertain' };
      }
      const hash = st?.receipts?.find((r) => typeof r?.transactionHash === 'string')
        ?.transactionHash as string | undefined;
      const txHash = hash && TX_HASH.test(hash) ? hash : null;
      const s = st?.status;
      if (s === 200 || s === 'CONFIRMED') return { kind: 'wallet_sent', txHash, state: 'sent' };
      if ((typeof s === 'number' && s >= 400) || s === 'FAILED' || s === 'REVERTED') {
        throw new WalletError('onchain_failed', { ...(txHash ? { txHash } : {}) });
      }
      if (Date.now() >= deadline) return { kind: 'wallet_sent', txHash, state: 'uncertain' };
      await sleep(2000);
    }
  }

  return {
    async methods(): Promise<GaslessMethod[]> {
      const { provider, address } = connected();
      const code = await provider
        .request({ method: 'eth_getCode', params: [address, 'latest'] })
        .catch(() => null);
      // 3009 and permit need an ECDSA signature by the address itself: an EOA (or one whose
      // wallet manages its own EIP-7702 delegation). Unknown code counts as an EOA.
      const eoa =
        typeof code !== 'string' ||
        code === '0x' ||
        code === '0x0' ||
        DELEGATION_DESIGNATOR.test(code);
      const caps = await provider
        .request({ method: 'wallet_getCapabilities', params: [address, [chainHex]] })
        .catch(() => null);
      const out: GaslessMethod[] = eoa ? ['eip3009', 'permit'] : [];
      if (paymasterSupported(caps, chainId)) out.push('paymaster');
      return out;
    },

    async nativeBalance() {
      const { provider, address } = connected();
      try {
        const raw = await provider.request({
          method: 'eth_getBalance',
          params: [address, 'latest'],
        });
        return typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw) ? BigInt(raw) : null;
      } catch {
        return null;
      }
    },

    async sign(p, e) {
      const { provider, address } = connected();
      if (!sameAddr(address, e.wallet)) throw new WalletError('account_changed', { address });
      if (e.method === 'paymaster') {
        checkPaymasterCalls(p, e, deps.paymasterUrlPrefix);
        await ready(provider, address);
        let res: unknown;
        try {
          res = await provider.request({
            method: 'wallet_sendCalls',
            params: [
              {
                version: '2.0.0',
                chainId: chainHex,
                from: address,
                atomicRequired: true,
                calls: p.calls,
                capabilities: { paymasterService: { url: p.paymaster_url } },
              },
            ],
          });
        } catch (err) {
          // The wallet signs and sends the batch itself: past a refusal it may be out (C33).
          throw afterSignError(err);
        }
        const id = typeof res === 'string' ? res : (res as { id?: unknown } | null)?.id;
        if (typeof id !== 'string' || !id) {
          return { kind: 'wallet_sent', txHash: null, state: 'uncertain' };
        }
        return waitForCalls(provider, id);
      }

      const parts = checkEvmTypedData(p, e, deps.forwarder);
      await ready(provider, address);
      const signatures: Record<string, SignedPart> = {};
      for (const part of parts) {
        let sig: unknown;
        try {
          sig = await provider.request({
            method: 'eth_signTypedData_v4',
            params: [address, JSON.stringify(part.typed_data)],
          });
        } catch (err) {
          // Only a signature: nothing has been sent yet.
          throw toWalletError(err);
        }
        if (typeof sig !== 'string' || !SIGNATURE.test(sig)) {
          throw new WalletError('failed', { detail: 'bad signature' });
        }
        signatures[part.kind] = { message: part.typed_data.message, signature: sig };
      }
      return { kind: 'submit', body: { signatures } };
    },
  };
}
