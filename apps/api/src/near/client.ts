// The API's NEAR client. Two keys, never mixed:
//   - `relayer-accounts` signs `call()` (gas only) from its implicit account;
//   - `funding-near` signs `provisionAccount()` from the mode's parent account.
// `nearClient(livemode)` picks the mode's RPC / parent / intents / code hash and wraps the driver
// (RPC, or the in-memory fake in dev/test) in the funding caps.
import { env, type Env } from '../env.js';
import { getKeyVault } from '../keyvault/index.js';
import { nearPublicKey } from '../keyvault/keys.js';
import type { KeyVault } from '../keyvault/types.js';
import { providerNotConfigured } from '../lib/errors.js';
import { FakeNearClient } from './fake.js';
import {
  CappedNearClient,
  assertProvisionable,
  assertTestnetAdminCall,
  type ProvisionScope,
} from './provision.js';
import {
  JsonRpcTransport,
  NearRpc,
  NotBroadcastError,
  isInvalidNonce,
  isInvalidTransaction,
} from './rpc.js';
import {
  DEFAULT_CALL_GAS,
  buildTransaction,
  decodeHash,
  functionCallAction,
  implicitAccountId,
  provisionActions,
  signTransaction,
  type NearSigningKey,
  type SignedTx,
} from './tx.js';
import type { Action } from '@near-js/transactions';

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
}

export interface ProvisionParams {
  /** The merchant the account is for; the `funding.spent` event is recorded against it. */
  merchantId: string;
  livemode: boolean;
  accountId: string;
  init: InitConfigJson;
  initialBalanceYocto: bigint;
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
  /** Public keys (`ed25519:…`) of the account's access keys. */
  accessKeys(accountId: string): Promise<string[]>;
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
   * (InvalidTxError). Any other send error (timeout, network) is rethrown as is: the outcome is
   * unknown.
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
    const fake = new FakeNearClient(config);
    return { client: new CappedNearClient(fake, config, caps), fake };
  }
  const rpc = new NearRpc(
    new JsonRpcTransport(livemode ? e.NEAR_RPC_URL_LIVE : e.NEAR_RPC_URL_TEST),
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

/** Drops the cached clients (tests: fresh fakes per test). */
export function resetNearClients(): void {
  clients.clear();
}
