// The API's NEAR client. Two keys, never mixed:
//   - `relayer-accounts` signs `call()` (gas only) from its implicit account;
//   - `funding-near` signs `provisionAccount()` and `topUpAccount()` (storage NEAR for a merchant
//     account) from the mode's parent account.
// `nearClient(livemode)` picks the mode's RPC / parent / intents / code hash and wraps the driver
// (RPC, or the in-memory fake in dev/test) in the funding caps.
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { env, type Env } from '../env.js';
import { getKeyVault } from '../keyvault/index.js';
import { nearPublicKey } from '../keyvault/keys.js';
import type { KeyVault } from '../keyvault/types.js';
import { providerNotConfigured } from '../lib/errors.js';
import { getRedis } from '../lib/redis.js';
import { FakeNearClient } from './fake.js';
import {
  CappedNearClient,
  assertProvisionable,
  assertTestnetAdminCall,
  assertTopUpAllowed,
  type ProvisionScope,
} from './provision.js';
import {
  JsonRpcTransport,
  NearRpc,
  NotBroadcastError,
  OutcomeUnknownError,
  isInvalidNonce,
  isInvalidTransaction,
  type AccountState,
} from './rpc.js';
import {
  DEFAULT_CALL_GAS,
  NEAR_HOOK_ATTACHED_GAS,
  NEAR_HOOK_METHOD,
  buildTransaction,
  decodeHash,
  functionCallAction,
  implicitAccountId,
  provisionActions,
  signTransaction,
  transferAction,
  type NearSigningKey,
  type SignOptions,
  type SignedTx,
} from './tx.js';
import { assertHookTransaction, type HookArgs } from '../hooks/guard.js';
import type { Action } from '@near-js/transactions';
import type { TxReceipt } from './events.js';

/** `relayer-near` nonce lock: held at most this long (one view call + two Redis calls). */
export const NEAR_NONCE_LOCK_TTL_MS = 15_000;
/** How long a signer waits for the nonce lock. */
export const NEAR_NONCE_LOCK_WAIT_MS = 10_000;
/** How long the last handed-out nonce is remembered (the chain's own nonce catches up first). */
export const NEAR_NONCE_RECORD_TTL_S = 24 * 3600;

/** contract `SignerKey` JSON (serde `rename_all = "snake_case"`), standard padded base64. */
export type SignerKeyJson = { p256: string } | { ed25519: string };

/** JSON of the merchant-account contract's `InitConfig` (onchain/merchant-account/src/lib.rs). */
export interface InitConfigJson {
  signers: { id: string; keys: SignerKeyJson[] }[];
  threshold: number;
  /** base64 of the 32-byte Ed25519 recovery public key. */
  recovery_key: string | null;
  rp_id: string;
  origins: string[];
  intents_contract: string;
  /** `omft.near` when null. */
  poa_suffix: string | null;
  /** Accepted only by `testnet-admin` builds; always null on live accounts. */
  testnet_admin: string | null;
}

/**
 * A final transaction outcome.
 *
 * - `logs` are the logs of every outcome (transaction and receipts), failed ones included: a
 *   receipt that panicked may still have logged before it did. `successLogs` keeps only the logs
 *   of outcomes that succeeded. Contract events must be read from `successLogs` (a failed
 *   receipt's state changes were rolled back, so its events never happened).
 *
 * - `status` is `'failure'` if ANY receipt failed, including downstream promises the contract
 *   started and settles in its own callback (a verifier transfer that bounced, say).
 * - `topLevelStatus` is the transaction's own result (`FinalExecutionOutcome.status`): the called
 *   method, plus any promise it *returned*. For a method that returns a plain value (the account
 *   contract's `propose` / `approve` / `cancel`), a downstream failure leaves it `'success'`.
 *
 * So judge whether a contract call took effect by `topLevelStatus` and by the contract's own
 * NEP-297 events in `successLogs`, never by `status` alone.
 */
export interface TxResult {
  txHash: string;
  logs: string[];
  successLogs: string[];
  status: 'success' | 'failure';
  topLevelStatus: 'success' | 'failure';
  failure?: string;
  /** yoctoNEAR burnt for gas by the transaction and all its receipts (when the RPC reports it). */
  tokensBurnt?: bigint;
}

export interface ProvisionParams {
  /** The merchant the account is for; the `funding.spent` event is recorded against it. */
  merchantId: string;
  livemode: boolean;
  accountId: string;
  init: InitConfigJson;
  initialBalanceYocto: bigint;
}

/** Storage NEAR `funding-near` sends to an existing merchant account (R35). */
export interface TopUpParams {
  /** The merchant the account belongs to; the `funding.topup` event is recorded against it. */
  merchantId: string;
  livemode: boolean;
  accountId: string;
  amountYocto: bigint;
}

export type { AccountState };

/** A transaction's final outcome (`EXPERIMENTAL_tx_status`): who sent it and every receipt. */
export interface TxStatusResult {
  hash: string;
  signerId: string;
  receiverId: string;
  /** `sender_id` of each NEP-366 delegate action (meta-transaction): the real sender. */
  delegateSenderIds?: string[];
  /** Every receipt (not the transaction outcome itself), with its executor and logs. */
  receipts: TxReceipt[];
  /** yoctoNEAR / gas burnt by the transaction and all its receipts (RPC lookups only). */
  tokensBurnt?: bigint;
  gasBurnt?: bigint;
  /** The transaction's own result (`FinalExecutionOutcome.status`) succeeded. */
  topLevelOk?: boolean;
}

export interface CallOptions {
  gas?: bigint;
  deposit?: bigint;
}

export interface NearClient {
  call(
    signer: 'relayer-accounts',
    contractId: string,
    method: string,
    args: object,
    opts?: CallOptions,
  ): Promise<TxResult>;
  view<T>(contractId: string, method: string, args: object): Promise<T>;
  provisionAccount(p: ProvisionParams): Promise<TxResult>;
  /**
   * Sends `amountYocto` from the mode's parent account (`funding-near`) to an existing merchant
   * account, for its contract storage. Same request guards and funding caps as provisioning.
   */
  topUpAccount(p: TopUpParams): Promise<TxResult>;
  /** Balance and storage use of an account (`view_account`). */
  viewAccount(accountId: string): Promise<AccountState>;
  /** Public keys (`ed25519:…`) of the account's access keys. */
  accessKeys(accountId: string): Promise<string[]>;
  /**
   * The final outcome of transaction `hash` with its receipts and their logs
   * (`EXPERIMENTAL_tx_status`); null when the node does not know the transaction (yet).
   * `senderOrReceiverAccountId` routes the lookup to a shard: the sender when known, else the
   * receiver (the intents contract, for a 1Click settlement).
   */
  txStatus(hash: string, senderOrReceiverAccountId?: string): Promise<TxStatusResult | null>;
  /**
   * TESTNET ONLY. Calls `method` on a test merchant account as its `testnet_admin` — the test
   * parent account, signed by its `funding-near` key — e.g. `admin_sync_signers` to mirror the
   * live signer set. Throws on a live client: live accounts have no admin, and the live funding
   * key never calls contracts.
   */
  callAsTestnetAdmin(
    contractId: string,
    method: string,
    args: object,
    opts?: CallOptions,
  ): Promise<TxResult>;
  /**
   * Optional: throws if `provisionAccount(p)` cannot even be attempted (bad request, missing
   * configuration, key vault unavailable). Called before any funding is reserved.
   */
  preflightProvision?(p: ProvisionParams): Promise<void>;
}

export interface NearModeConfig extends ProvisionScope {
  /** Global merchant-account code hash; provisioning is refused while unset. */
  codeHash?: Uint8Array;
}

export class RpcNearClient implements NearClient {
  private readonly rpc: NearRpc;
  private readonly kv: KeyVault;
  private readonly config: NearModeConfig;
  /** Last nonce used per signer key, so back-to-back txs don't reuse a nonce the node lags on. */
  private readonly lastNonce = new Map<string, bigint>();

  constructor(opts: { rpc: NearRpc; kv: KeyVault; config: NearModeConfig }) {
    this.rpc = opts.rpc;
    this.kv = opts.kv;
    this.config = opts.config;
  }

  async call(
    signer: 'relayer-accounts',
    contractId: string,
    method: string,
    args: object,
    opts: CallOptions = {},
  ): Promise<TxResult> {
    if (signer !== 'relayer-accounts') {
      throw new Error(`call() signs with relayer-accounts only, not ${String(signer)}`);
    }
    const pk = await this.ed25519PublicKey('relayer-accounts');
    return this.signAndSend('relayer-accounts', implicitAccountId(pk), pk, contractId, [
      functionCallAction(method, args, opts.gas ?? DEFAULT_CALL_GAS, opts.deposit ?? 0n),
    ]);
  }

  view<T>(contractId: string, method: string, args: object): Promise<T> {
    return this.rpc.viewFunction<T>(contractId, method, args);
  }

  async callAsTestnetAdmin(
    contractId: string,
    method: string,
    args: object,
    opts: CallOptions = {},
  ): Promise<TxResult> {
    assertTestnetAdminCall(this.config, contractId);
    const pk = await this.ed25519PublicKey('funding-near');
    return this.signAndSend('funding-near', this.config.parentAccountId, pk, contractId, [
      functionCallAction(method, args, opts.gas ?? DEFAULT_CALL_GAS, opts.deposit ?? 0n),
    ]);
  }

  accessKeys(accountId: string): Promise<string[]> {
    return this.rpc.accessKeyList(accountId);
  }

  viewAccount(accountId: string): Promise<AccountState> {
    return this.rpc.viewAccount(accountId);
  }

  txStatus(hash: string, senderOrReceiverAccountId?: string): Promise<TxStatusResult | null> {
    return this.rpc.txStatus(hash, senderOrReceiverAccountId ?? this.config.intentsContractId);
  }

  async topUpAccount(p: TopUpParams): Promise<TxResult> {
    let pk: Uint8Array;
    try {
      assertTopUpAllowed(p, this.config);
      pk = await this.ed25519PublicKey('funding-near');
    } catch (err) {
      throw new NotBroadcastError(err);
    }
    return this.signAndSend('funding-near', this.config.parentAccountId, pk, p.accountId, [
      transferAction(p.amountYocto),
    ]);
  }

  /**
   * Everything provisioning needs before any funding is reserved: a valid request, the mode's code
   * hash, and a reachable ed25519 `funding-near` key in the vault.
   */
  async preflightProvision(p: ProvisionParams): Promise<void> {
    await this.provisionInputs(p);
  }

  async provisionAccount(p: ProvisionParams): Promise<TxResult> {
    let inputs: { pk: Uint8Array; codeHash: Uint8Array };
    try {
      inputs = await this.provisionInputs(p);
    } catch (err) {
      throw new NotBroadcastError(err);
    }
    return this.signAndSend(
      'funding-near',
      this.config.parentAccountId,
      inputs.pk,
      p.accountId,
      provisionActions({
        initialBalanceYocto: p.initialBalanceYocto,
        codeHash: inputs.codeHash,
        init: p.init,
      }),
    );
  }

  private async provisionInputs(
    p: ProvisionParams,
  ): Promise<{ pk: Uint8Array; codeHash: Uint8Array }> {
    assertProvisionable(p, this.config);
    if (!this.config.codeHash) {
      throw providerNotConfigured(
        `MERCHANT_ACCOUNT_CODE_HASH_${this.config.livemode ? 'LIVE' : 'TEST'} is not set`,
      );
    }
    return { pk: await this.ed25519PublicKey('funding-near'), codeHash: this.config.codeHash };
  }

  private async ed25519PublicKey(key: NearSigningKey): Promise<Uint8Array> {
    const { curve, raw } = await this.kv.publicKey(key);
    if (curve !== 'ed25519') throw new Error(`${key} is not an ed25519 key`);
    return raw;
  }

  /**
   * Builds, vault-signs and sends one transaction; on InvalidNonce refetches and retries once.
   *
   * Throws NotBroadcastError when nothing reached the chain: a failure before `send_tx` (vault,
   * nonce or block lookup, signing) or the node rejecting the transaction itself
   * (InvalidTxError).
   *
   * Any other send error (timeout, network) leaves the outcome unknown. The identical signed
   * transaction is then sent once more (same hash: it can execute at most once). If that resend
   * returns an outcome, it is the answer; if it fails in any way, including InvalidNonce (which
   * then most likely means the first send used the nonce), the error is OutcomeUnknownError, never
   * NotBroadcastError, so callers keep funding reservations and relay claims.
   *
   * Nonces: next = max(node nonce, last nonce this process handed out) + 1 and the counter is
   * never reset, so a retry never reuses a nonce already given to a concurrent in-flight call.
   * The counter is per process: several API/worker instances signing with one key can still
   * collide (each then retries once).
   */
  private async signAndSend(
    key: NearSigningKey,
    signerId: string,
    publicKey: Uint8Array,
    receiverId: string,
    actions: Action[],
  ): Promise<TxResult> {
    const nonceKey = `${signerId}/${key}`;
    for (let attempt = 0; ; attempt++) {
      let signed: SignedTx;
      try {
        const fetched = await this.rpc.accessKeyNonce(signerId, nearPublicKey(publicKey));
        const last = this.lastNonce.get(nonceKey) ?? 0n;
        const nonce = (fetched > last ? fetched : last) + 1n;
        this.lastNonce.set(nonceKey, nonce);
        const tx = buildTransaction({
          signerId,
          publicKey,
          nonce,
          receiverId,
          blockHash: await this.rpc.finalBlockHash(),
          actions,
        });
        signed = await signTransaction(this.kv, key, tx);
      } catch (err) {
        throw new NotBroadcastError(err);
      }
      try {
        return await this.rpc.sendTx(signed.bytes, signed.hash);
      } catch (err) {
        if (attempt === 0 && isInvalidNonce(err)) continue;
        if (isInvalidTransaction(err)) throw new NotBroadcastError(err);
        try {
          return await this.rpc.sendTx(signed.bytes, signed.hash);
        } catch (resendErr) {
          throw new OutcomeUnknownError(err, resendErr);
        }
      }
    }
  }
}

/**
 * `relayer-near`'s sender (gasless NEAR payments and integrator hooks, project 5a): signs from its
 * implicit account only what `assertRelayerNearTransaction` allows (one signed delegate, one
 * registration-only `storage_deposit`, or one records-checked `on_tendr_deposit`). Signing and sending are separate steps, so a caller can record a
 * transaction's hash before it is broadcast. Never used by `NearClient.call`, provisioning or
 * top-ups.
 *
 * Nonces (final review I2): the key signs from the API (meta-tx relays, `storage_deposit`) and the
 * worker (hooks, fee-sweep registrations) at once, so the next nonce is taken under a Redis lock
 * per (account, public key): a fresh on-chain nonce read under the lock, next = max(that, the last
 * nonce any process handed out (Redis), this process's last) + 1, recorded before the lock is
 * released. Two signers never get the same nonce. Fails closed (NotBroadcastError).
 */
export class RelayerNearSender {
  private lastNonce = 0n;
  private key: { raw: Uint8Array; accountId: string } | null = null;

  constructor(
    readonly rpc: NearRpc,
    private readonly kv: KeyVault = getKeyVault(),
    private readonly redis: () => Redis = getRedis,
  ) {}

  /** The next nonce for the key, under the cross-process nonce lock. */
  private async nextNonce(accountId: string, publicKey: string): Promise<bigint> {
    const redis = this.redis();
    // A fresh process's client may still be connecting (commands fail fast, no offline queue).
    if (redis.status === 'connecting' || redis.status === 'connect' || redis.status === 'wait') {
      await Promise.race([
        new Promise((r) => redis.once('ready', r)),
        new Promise((r) => setTimeout(r, NEAR_NONCE_LOCK_WAIT_MS)),
      ]);
    }
    const lockKey = `tendr:near-nonce-lock:${accountId}:${publicKey}`;
    const lastKey = `tendr:near-nonce:${accountId}:${publicKey}`;
    const token = randomUUID();
    const waitUntil = Date.now() + NEAR_NONCE_LOCK_WAIT_MS;
    while ((await redis.set(lockKey, token, 'PX', NEAR_NONCE_LOCK_TTL_MS, 'NX')) !== 'OK') {
      if (Date.now() > waitUntil) throw new Error('the relayer-near nonce lock is busy');
      await new Promise((r) => setTimeout(r, 20));
    }
    try {
      const fetched = await this.rpc.accessKeyNonce(accountId, publicKey);
      const stored = BigInt((await redis.get(lastKey)) ?? '0');
      let base = fetched > stored ? fetched : stored;
      if (this.lastNonce > base) base = this.lastNonce;
      const nonce = base + 1n;
      // Recorded only while the lock is still ours: another signer reads it next.
      const ok = await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end",
        2,
        lockKey,
        lastKey,
        token,
        nonce.toString(),
        String(NEAR_NONCE_RECORD_TTL_S),
      );
      if (Number(ok) !== 1) throw new Error('the relayer-near nonce lock expired');
      this.lastNonce = nonce;
      return nonce;
    } finally {
      try {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          token,
        );
      } catch {
        // Expires on its own (NEAR_NONCE_LOCK_TTL_MS).
      }
    }
  }

  private async publicKey(): Promise<{ raw: Uint8Array; accountId: string }> {
    if (this.key) return this.key;
    const { curve, raw } = await this.kv.publicKey('relayer-near');
    if (curve !== 'ed25519') throw new Error('relayer-near is not an ed25519 key');
    this.key = { raw, accountId: implicitAccountId(raw) };
    return this.key;
  }

  /** The relayer's implicit account (it pays the gas). */
  async accountId(): Promise<string> {
    return (await this.publicKey()).accountId;
  }

  /**
   * Builds and vault-signs an integrator hook call (`on_tendr_deposit`) to `receiverId`, only
   * after the records check (`assertHookTransaction`: the receiver is the session's settlement
   * contract and `args` are exactly the hook's), and only with the hook allowance for that
   * receiver. NotBroadcastError on any failure (nothing sent).
   */
  async signHook(hookCallId: string, receiverId: string, args: HookArgs): Promise<SignedTx> {
    try {
      await assertHookTransaction({ hookCallId, chain: 'near', receiverId, args: { ...args } });
    } catch (err) {
      throw new NotBroadcastError(err);
    }
    const action = functionCallAction(NEAR_HOOK_METHOD, args, NEAR_HOOK_ATTACHED_GAS, 0n);
    return this.sign(receiverId, [action], { hookReceiver: receiverId });
  }

  /** Builds and vault-signs one transaction; NotBroadcastError on any failure (nothing sent). */
  async sign(receiverId: string, actions: Action[], opts: SignOptions = {}): Promise<SignedTx> {
    try {
      const { raw, accountId } = await this.publicKey();
      const nonce = await this.nextNonce(accountId, nearPublicKey(raw));
      const tx = buildTransaction({
        signerId: accountId,
        publicKey: raw,
        nonce,
        receiverId,
        blockHash: await this.rpc.finalBlockHash(),
        actions,
      });
      return await signTransaction(this.kv, 'relayer-near', tx, opts);
    } catch (err) {
      throw new NotBroadcastError(err);
    }
  }

  /**
   * Sends a signed transaction and waits until it is final. NotBroadcastError when the node
   * rejected it as invalid (never executed); any other failure resends the identical bytes once,
   * and if that fails too, OutcomeUnknownError (it may still execute: same hash, at most once).
   */
  async send(signed: SignedTx): Promise<TxResult> {
    try {
      return await this.rpc.sendTx(signed.bytes, signed.hash);
    } catch (err) {
      if (isInvalidTransaction(err)) throw new NotBroadcastError(err);
      try {
        return await this.rpc.sendTx(signed.bytes, signed.hash);
      } catch (resendErr) {
        throw new OutcomeUnknownError(err, resendErr);
      }
    }
  }

  /** `sign` then `send`; a stale nonce at the first send re-signs once with a fresh one. */
  async signAndSend(receiverId: string, actions: Action[]): Promise<TxResult> {
    for (let attempt = 0; ; attempt++) {
      const signed = await this.sign(receiverId, actions);
      try {
        return await this.send(signed);
      } catch (err) {
        if (attempt === 0 && err instanceof NotBroadcastError && isInvalidNonce(err.cause)) {
          continue;
        }
        throw err;
      }
    }
  }
}

export function nearModeConfig(livemode: boolean, e: Env = env()): NearModeConfig {
  const hash = livemode ? e.MERCHANT_ACCOUNT_CODE_HASH_LIVE : e.MERCHANT_ACCOUNT_CODE_HASH_TEST;
  return {
    livemode,
    parentAccountId: livemode ? e.NEAR_PARENT_ACCOUNT_LIVE : e.NEAR_PARENT_ACCOUNT_TEST,
    intentsContractId: livemode ? e.INTENTS_CONTRACT_LIVE : e.INTENTS_CONTRACT_TEST,
    ...(hash ? { codeHash: decodeHash(hash) } : {}),
  };
}

const clients = new Map<boolean, { client: NearClient; fake?: FakeNearClient }>();

function build(livemode: boolean): { client: NearClient; fake?: FakeNearClient } {
  const e = env();
  const config = nearModeConfig(livemode, e);
  const caps = {
    perAccountYocto: e.FUNDING_PER_ACCOUNT_YOCTO,
    dailyYocto: e.FUNDING_DAILY_CAP_YOCTO,
  };
  if (e.NEAR_CLIENT_DRIVER === 'fake') {
    const fake = new FakeNearClient(config, {
      simulateContracts: e.NEAR_FAKE_SIMULATE,
      timelockNs:
        e.NEAR_FAKE_TIMELOCK_SECONDS === undefined
          ? undefined
          : BigInt(e.NEAR_FAKE_TIMELOCK_SECONDS) * 1_000_000_000n,
    });
    return { client: new CappedNearClient(fake, config, caps), fake };
  }
  const primaryUrl = livemode ? e.NEAR_RPC_URL_LIVE : e.NEAR_RPC_URL_TEST;
  const archivalUrl = livemode ? e.NEAR_RPC_URL_LIVE_ARCHIVAL : e.NEAR_RPC_URL_TEST_ARCHIVAL;
  const rpc = new NearRpc(
    new JsonRpcTransport(primaryUrl),
    archivalUrl !== primaryUrl ? new JsonRpcTransport(archivalUrl) : null,
  );
  const inner = new RpcNearClient({ rpc, kv: getKeyVault(), config });
  return { client: new CappedNearClient(inner, config, caps) };
}

/** The process-wide NEAR client for a mode, chosen by `NEAR_CLIENT_DRIVER`, funding-capped. */
export function nearClient(livemode: boolean): NearClient {
  let entry = clients.get(livemode);
  if (!entry) {
    entry = build(livemode);
    clients.set(livemode, entry);
  }
  return entry.client;
}

/** The in-memory fake behind `nearClient(livemode)`; throws unless `NEAR_CLIENT_DRIVER=fake`. */
export function fakeNearClient(livemode: boolean): FakeNearClient {
  nearClient(livemode);
  const fake = clients.get(livemode)?.fake;
  if (!fake) throw new Error('NEAR_CLIENT_DRIVER is not fake');
  return fake;
}

const relayerSenders = new Map<boolean, RelayerNearSender>();

/** The process-wide `relayer-near` sender for a mode (its RPC is the mode's NEAR_RPC_URL_*). */
export function relayerNearSender(livemode: boolean): RelayerNearSender {
  let s = relayerSenders.get(livemode);
  if (!s) {
    const e = env();
    const primaryUrl = livemode ? e.NEAR_RPC_URL_LIVE : e.NEAR_RPC_URL_TEST;
    const archivalUrl = livemode ? e.NEAR_RPC_URL_LIVE_ARCHIVAL : e.NEAR_RPC_URL_TEST_ARCHIVAL;
    s = new RelayerNearSender(
      new NearRpc(
        new JsonRpcTransport(primaryUrl),
        archivalUrl !== primaryUrl ? new JsonRpcTransport(archivalUrl) : null,
      ),
    );
    relayerSenders.set(livemode, s);
  }
  return s;
}

/** Drops the cached clients (tests: fresh fakes per test). */
export function resetNearClients(): void {
  clients.clear();
  relayerSenders.clear();
}
