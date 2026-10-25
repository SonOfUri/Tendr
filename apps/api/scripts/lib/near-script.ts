// Helpers for the two manual NEAR scripts (onchain-publish-testnet.ts, verify-merchant-account-mainnet.ts).
// These scripts sign with a plain ed25519 key the operator supplies (a funded account of their own),
// never with Tendr's KMS keys. They are never run by CI.
import { KeyType, PublicKey } from '@near-js/crypto';
import {
  AccessKey,
  AccessKeyPermission,
  Action,
  AddKey,
  DeleteAccount,
  DeployContract,
  DeployGlobalContract,
  FullAccessPermission,
  GlobalContractDeployMode,
  Signature,
  SignedTransaction,
} from '@near-js/transactions';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';
import { nearPublicKey } from '../../src/keyvault/keys.js';
import { NearRpc, JsonRpcTransport, type RpcTransport } from '../../src/near/rpc.js';
import { buildTransaction } from '../../src/near/tx.js';

/** A refusal to run: bad or missing flags. The script prints `message` and exits non-zero. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;

/** `1.5` -> yoctoNEAR. */
export function parseNear(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(s);
  if (!m) throw new UsageError(`not a NEAR amount: ${s}`);
  return BigInt(m[1]!) * NEAR + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
}

export function formatNear(yocto: bigint): string {
  const whole = yocto / NEAR;
  const frac = (yocto % NEAR).toString().padStart(24, '0').slice(0, 4);
  return `${whole}.${frac} NEAR`;
}

/**
 * Splits argv into `--flag value` / `--flag` pairs. Unknown flags and stray positionals are
 * refused, so a typo can never silently skip a safety flag.
 */
export function parseFlags(
  argv: readonly string[],
  spec: Readonly<Record<string, 'bool' | 'value'>>,
): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') ? (eq > 0 ? arg.slice(2, eq) : arg.slice(2)) : '';
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown argument: ${arg}`);
    if (kind === 'bool') {
      if (eq > 0) throw new UsageError(`--${name} takes no value`);
      out.set(name, true);
    } else {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new UsageError(`--${name} needs a value`);
      }
      out.set(name, value);
    }
  }
  return out;
}

export interface LocalKey {
  /** 32-byte Ed25519 seed. */
  seed: Uint8Array;
  publicKey: Uint8Array;
  /** `ed25519:<base58>` public key. */
  nearPublicKey: string;
}

/** Parses a NEAR `ed25519:<base58 of 64 bytes>` secret key (near-cli format). */
export function parseSecretKey(s: string): LocalKey {
  const m = /^ed25519:(.+)$/.exec(s.trim());
  if (!m) throw new UsageError('private key must look like ed25519:<base58>');
  let raw: Uint8Array;
  try {
    raw = bs58.decode(m[1]!);
  } catch {
    throw new UsageError('private key is not valid base58');
  }
  if (raw.length !== 64 && raw.length !== 32) {
    throw new UsageError('private key must decode to 32 or 64 bytes');
  }
  const seed = raw.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  if (
    raw.length === 64 &&
    Buffer.compare(Buffer.from(raw.slice(32)), Buffer.from(publicKey)) !== 0
  ) {
    throw new UsageError('private key: the public half does not match the seed');
  }
  return { seed, publicKey, nearPublicKey: nearPublicKey(publicKey) };
}

/** The raw `send_tx` outcome; only the fields the scripts read. */
export interface RawOutcome {
  status: unknown;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string; outcome: RawExec };
  receipts_outcome?: { id?: string; outcome: RawExec }[];
}
interface RawExec {
  logs: string[];
  status: unknown;
  executor_id?: string;
}

export function failureOf(status: unknown): string | undefined {
  if (status && typeof status === 'object' && 'Failure' in status) {
    return JSON.stringify((status as { Failure: unknown }).Failure);
  }
  return undefined;
}

/** The first failure anywhere in the outcome (transaction or any receipt), if any. */
export function firstFailure(o: RawOutcome): string | undefined {
  return (
    failureOf(o.status) ??
    [o.transaction_outcome, ...(o.receipts_outcome ?? [])]
      .map((r) => (r ? failureOf(r.outcome.status) : undefined))
      .find(Boolean)
  );
}

/** Every receipt's executor, base64-decoded SuccessValue and logs, for printing. */
export function describeReceipts(
  o: RawOutcome,
): { executor: string; value: string | null; failed: string | null; logs: string[] }[] {
  return (o.receipts_outcome ?? []).map((r) => {
    const st = r.outcome.status as { SuccessValue?: string } | string;
    const value =
      typeof st === 'object' && st && typeof st.SuccessValue === 'string'
        ? Buffer.from(st.SuccessValue, 'base64').toString('utf8')
        : null;
    return {
      executor: r.outcome.executor_id ?? '?',
      value,
      failed: failureOf(r.outcome.status) ?? null,
      logs: r.outcome.logs,
    };
  });
}

/** An account the script signs for with a local ed25519 key. */
export class ScriptAccount {
  readonly rpc: NearRpc;
  private lastNonce = 0n;

  constructor(
    readonly accountId: string,
    private readonly key: LocalKey,
    readonly transport: RpcTransport,
  ) {
    this.rpc = new NearRpc(transport);
  }

  static open(accountId: string, secret: string, rpcUrl: string): ScriptAccount {
    return new ScriptAccount(accountId, parseSecretKey(secret), new JsonRpcTransport(rpcUrl));
  }

  get publicKey(): LocalKey {
    return this.key;
  }

  /** Signs and sends one transaction to `receiverId`, waiting until it is final. */
  async send(receiverId: string, actions: Action[]): Promise<RawOutcome> {
    const fetched = await this.rpc.accessKeyNonce(this.accountId, this.key.nearPublicKey);
    const nonce = (fetched > this.lastNonce ? fetched : this.lastNonce) + 1n;
    this.lastNonce = nonce;
    return this.sendWithNonce(receiverId, actions, nonce);
  }

  /** Sends with an explicit nonce (to observe how the node reports a stale one). */
  async sendWithNonce(receiverId: string, actions: Action[], nonce: bigint): Promise<RawOutcome> {
    const tx = buildTransaction({
      signerId: this.accountId,
      publicKey: this.key.publicKey,
      nonce,
      receiverId,
      blockHash: await this.rpc.finalBlockHash(),
      actions,
    });
    const digest = sha256(tx.encode());
    const signed = new SignedTransaction({
      transaction: tx,
      signature: new Signature({
        keyType: KeyType.ED25519,
        data: ed25519.sign(digest, this.key.seed),
      }),
    });
    return this.transport.request<RawOutcome>('send_tx', {
      signed_tx_base64: Buffer.from(signed.encode()).toString('base64'),
      wait_until: 'FINAL',
    });
  }

  /** Sends and throws with the first failure unless every receipt succeeded. */
  async sendOk(receiverId: string, actions: Action[], what: string): Promise<RawOutcome> {
    const o = await this.send(receiverId, actions);
    const failure = firstFailure(o);
    if (failure) throw new Error(`${what} failed: ${failure}`);
    return o;
  }

  async accountBalance(accountId: string): Promise<bigint> {
    const r = await this.transport.request<{ amount: string }>('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    return BigInt(r.amount);
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.accountBalance(accountId);
      return true;
    } catch (err) {
      if (/does not exist|UNKNOWN_ACCOUNT|UnknownAccount/i.test(String(err))) return false;
      throw err;
    }
  }
}

export const deployContractAction = (code: Uint8Array): Action =>
  new Action({ deployContract: new DeployContract({ code }) });

/** Publishes `code` as a global contract identified by its code hash (NEP-591). */
export const deployGlobalByHashAction = (code: Uint8Array): Action =>
  new Action({
    deployGlobalContract: new DeployGlobalContract({
      code,
      deployMode: new GlobalContractDeployMode({ CodeHash: null }),
    }),
  });

export const addFullAccessKeyAction = (publicKey: Uint8Array): Action =>
  new Action({
    addKey: new AddKey({
      publicKey: new PublicKey({ keyType: KeyType.ED25519, data: publicKey }),
      accessKey: new AccessKey({
        nonce: 0n,
        permission: new AccessKeyPermission({ fullAccess: new FullAccessPermission() }),
      }),
    }),
  });

export const deleteAccountAction = (beneficiaryId: string): Action =>
  new Action({ deleteAccount: new DeleteAccount({ beneficiaryId }) });

/** base58 of sha256(code): the code hash a global contract is published under. */
export function codeHashB58(code: Uint8Array): string {
  return bs58.encode(sha256(code));
}
