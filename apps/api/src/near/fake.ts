// In-memory NearClient for API tests and offline local dev: no network, no signing. It records
// every call (args deep-copied), returns scripted logs / view results, and tracks provisioned
// accounts (which, like real merchant accounts, have no access keys).
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import type {
  AccountState,
  CallOptions,
  InitConfigJson,
  NearClient,
  ProvisionParams,
  TopUpParams,
  TxResult,
} from './client.js';
import { FakeMerchantContracts, SimulatedPanic } from './fake-contract.js';
import {
  assertProvisionable,
  assertTestnetAdminCall,
  assertTopUpAllowed,
  type ProvisionScope,
} from './provision.js';
import { DEFAULT_CALL_GAS } from './tx.js';

export type FakeCall =
  | {
      kind: 'call';
      /** `funding-near` only for `callAsTestnetAdmin` (testnet). */
      signer: 'relayer-accounts' | 'funding-near';
      contractId: string;
      method: string;
      args: object;
      gas: bigint;
      deposit: bigint;
    }
  | { kind: 'view'; contractId: string; method: string; args: object }
  | { kind: 'provision'; accountId: string; init: InitConfigJson; initialBalanceYocto: bigint }
  | { kind: 'topup'; accountId: string; amountYocto: bigint };

type Kind = FakeCall['kind'];
type Scripted<T> = T | ((args: object) => T);

const fakeHash = (): string => bs58.encode(randomBytes(32));
/** Storage a freshly provisioned fake account reports (bytes), about what a real one uses. */
export const FAKE_ACCOUNT_STORAGE_BYTES = 2_000n;
const key = (contractId: string, method: string): string => `${contractId}#${method}`;

export class FakeNearClient implements NearClient {
  readonly calls: FakeCall[] = [];
  readonly accounts = new Map<string, { init: InitConfigJson; balanceYocto: bigint }>();
  /** The signer set of each provisioned account, as `get_config` reports it. */
  private readonly signerState = new Map<
    string,
    { signers: InitConfigJson['signers']; threshold: number; epoch: bigint }
  >();
  private readonly logs = new Map<string, Scripted<string[]>>();
  private readonly views = new Map<string, (args: object) => unknown>();
  private readonly keys = new Map<string, string[]>();
  private readonly failures = new Map<string, string[]>();
  private readonly downstreamFailures = new Map<
    string,
    { failure: string; failedLogs: string[] }[]
  >();
  private readonly provisionFailures: string[] = [];
  private readonly throws: Record<Kind, unknown[]> = {
    call: [],
    view: [],
    provision: [],
    topup: [],
  };
  /** Storage use (bytes) per account, as `viewAccount` reports it. */
  private readonly storage = new Map<string, bigint>();

  /**
   * With `simulateContracts`, provisioned accounts run an in-memory merchant-account contract
   * (fake-contract.ts) that answers unscripted calls and views with the contract's events; the
   * intents verifier answers `mt_batch_balance_of` with zeros. Local dev and end-to-end tests
   * only. Scripted logs, views and failures still take precedence.
   */
  readonly contracts: FakeMerchantContracts | null;

  constructor(
    readonly scope: ProvisionScope,
    opts: { simulateContracts?: boolean } = {},
  ) {
    this.contracts = opts.simulateContracts ? new FakeMerchantContracts() : null;
  }

  /** Logs returned by `call(contractId, method)` (e.g. NEP-297 `EVENT_JSON:` lines). */
  scriptLogs(contractId: string, method: string, logs: Scripted<string[]>): void {
    this.logs.set(key(contractId, method), logs);
  }

  /** `view(contractId, method)` returns `answer(args)`. */
  scriptView(contractId: string, method: string, answer: (args: object) => unknown): void {
    this.views.set(key(contractId, method), answer);
  }

  /** `accessKeys(accountId)` returns `keys` (whether or not the account was provisioned here). */
  scriptAccessKeys(accountId: string, keys: string[]): void {
    this.keys.set(accountId, [...keys]);
  }

  /** The next `call` to `method` (any contract) returns a failure with `failure`. */
  failNext(method: string, failure: string): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  /**
   * The next `call` to `method` lands (top-level success, scripted logs) but a downstream receipt
   * fails, so the result's `status` is `'failure'` while `topLevelStatus` is `'success'`.
   * `failedLogs` are logs that failed receipt emitted before panicking: they appear in `logs` but
   * not in `successLogs`.
   */
  failDownstreamNext(method: string, failure: string, failedLogs: string[] = []): void {
    this.downstreamFailures.set(method, [
      ...(this.downstreamFailures.get(method) ?? []),
      { failure, failedLogs },
    ]);
  }

  /** The next `provisionAccount` returns an on-chain failure and creates no account. */
  failNextProvision(failure = 'Smart contract panicked: provisioning failed'): void {
    this.provisionFailures.push(failure);
  }

  /** The next operation of `kind` is recorded, then throws `err` (e.g. a NotBroadcastError). */
  throwNext(kind: Kind, err: unknown): void {
    this.throws[kind].push(err);
  }

  /** Sets an account's balance and/or storage use as `viewAccount` reports them. */
  scriptAccountState(
    accountId: string,
    s: { balanceYocto?: bigint; storageUsageBytes?: bigint },
  ): void {
    const a = this.accounts.get(accountId);
    if (s.balanceYocto !== undefined) {
      if (!a) throw new Error(`FakeNearClient: account ${accountId} does not exist`);
      a.balanceYocto = s.balanceYocto;
    }
    if (s.storageUsageBytes !== undefined) this.storage.set(accountId, s.storageUsageBytes);
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.kind === 'call' && c.method === method);
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
    return this.recordCall(signer, contractId, method, args, opts);
  }

  async callAsTestnetAdmin(
    contractId: string,
    method: string,
    args: object,
    opts: CallOptions = {},
  ): Promise<TxResult> {
    assertTestnetAdminCall(this.scope, contractId);
    const result = await this.recordCall('funding-near', contractId, method, args, opts);
    const state = this.signerState.get(contractId);
    if (method === 'admin_sync_signers' && result.topLevelStatus === 'success' && state) {
      const a = args as { signers: InitConfigJson['signers']; threshold: number };
      this.contracts?.syncSigners(contractId, a.signers, a.threshold);
      this.signerState.set(contractId, {
        signers: structuredClone(a.signers),
        threshold: a.threshold,
        epoch: state.epoch + 1n,
      });
    }
    return result;
  }

  private async recordCall(
    signer: 'relayer-accounts' | 'funding-near',
    contractId: string,
    method: string,
    args: object,
    opts: CallOptions,
  ): Promise<TxResult> {
    this.calls.push({
      kind: 'call',
      signer,
      contractId,
      method,
      args: structuredClone(args),
      gas: opts.gas ?? DEFAULT_CALL_GAS,
      deposit: opts.deposit ?? 0n,
    });
    this.maybeThrow('call');
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) {
      return {
        txHash: fakeHash(),
        logs: [],
        successLogs: [],
        status: 'failure',
        topLevelStatus: 'failure',
        failure,
      };
    }
    const scripted = this.logs.get(key(contractId, method));
    let logs = typeof scripted === 'function' ? scripted(args) : (scripted ?? []);
    if (
      scripted === undefined &&
      signer === 'relayer-accounts' &&
      this.contracts?.has(contractId)
    ) {
      try {
        logs = this.contracts.call(contractId, method, args as Record<string, unknown>);
      } catch (err) {
        if (!(err instanceof SimulatedPanic)) throw err;
        return {
          txHash: fakeHash(),
          logs: [],
          successLogs: [],
          status: 'failure',
          topLevelStatus: 'failure',
          failure: err.message,
        };
      }
    }
    const downstream = this.downstreamFailures.get(method)?.shift();
    if (downstream !== undefined) {
      return {
        txHash: fakeHash(),
        logs: [...logs, ...downstream.failedLogs],
        successLogs: logs,
        status: 'failure',
        topLevelStatus: 'success',
        failure: downstream.failure,
      };
    }
    return {
      txHash: fakeHash(),
      logs,
      successLogs: logs,
      status: 'success',
      topLevelStatus: 'success',
    };
  }

  async view<T>(contractId: string, method: string, args: object): Promise<T> {
    this.calls.push({ kind: 'view', contractId, method, args: structuredClone(args) });
    this.maybeThrow('view');
    const k = key(contractId, method);
    const answer = this.views.get(k);
    if (!answer && method === 'get_config' && this.accounts.has(contractId)) {
      return this.configOf(contractId) as T;
    }
    if (!answer && this.contracts) {
      const simulated = this.contracts.view(contractId, method, args as Record<string, unknown>);
      if (simulated !== undefined) return simulated as T;
      if (contractId === this.scope.intentsContractId && method === 'mt_batch_balance_of') {
        return (args as { token_ids: string[] }).token_ids.map(() => '0') as T;
      }
    }
    if (!answer) throw new Error(`FakeNearClient: no view scripted for ${k}`);
    return answer(args) as T;
  }

  async preflightProvision(p: ProvisionParams): Promise<void> {
    assertProvisionable(p, this.scope);
  }

  async provisionAccount(p: ProvisionParams): Promise<TxResult> {
    assertProvisionable(p, this.scope);
    this.calls.push({
      kind: 'provision',
      accountId: p.accountId,
      init: structuredClone(p.init),
      initialBalanceYocto: p.initialBalanceYocto,
    });
    this.maybeThrow('provision');
    const failure =
      this.provisionFailures.shift() ??
      (this.accounts.has(p.accountId) ? `account ${p.accountId} already exists` : undefined);
    if (failure !== undefined) {
      return {
        txHash: fakeHash(),
        logs: [],
        successLogs: [],
        status: 'failure',
        topLevelStatus: 'failure',
        failure,
      };
    }
    this.accounts.set(p.accountId, {
      init: structuredClone(p.init),
      balanceYocto: p.initialBalanceYocto,
    });
    this.signerState.set(p.accountId, {
      signers: structuredClone(p.init.signers),
      threshold: p.init.threshold,
      epoch: 0n,
    });
    this.contracts?.init(p.accountId, p.init);
    return {
      txHash: fakeHash(),
      logs: [],
      successLogs: [],
      status: 'success',
      topLevelStatus: 'success',
    };
  }

  async viewAccount(accountId: string): Promise<AccountState> {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error(`FakeNearClient: account ${accountId} does not exist`);
    return {
      amountYocto: a.balanceYocto,
      lockedYocto: 0n,
      storageUsageBytes: this.storage.get(accountId) ?? FAKE_ACCOUNT_STORAGE_BYTES,
    };
  }

  async topUpAccount(p: TopUpParams): Promise<TxResult> {
    assertTopUpAllowed(p, this.scope);
    this.calls.push({ kind: 'topup', accountId: p.accountId, amountYocto: p.amountYocto });
    this.maybeThrow('topup');
    const a = this.accounts.get(p.accountId);
    if (!a) {
      return {
        txHash: fakeHash(),
        logs: [],
        successLogs: [],
        status: 'failure',
        topLevelStatus: 'failure',
        failure: `account ${p.accountId} does not exist`,
      };
    }
    a.balanceYocto += p.amountYocto;
    return {
      txHash: fakeHash(),
      logs: [],
      successLogs: [],
      status: 'success',
      topLevelStatus: 'success',
    };
  }

  async accessKeys(accountId: string): Promise<string[]> {
    const scripted = this.keys.get(accountId);
    if (scripted) return [...scripted];
    if (!this.accounts.has(accountId)) {
      throw new Error(`FakeNearClient: account ${accountId} does not exist`);
    }
    return [];
  }

  /** The contract's `ConfigView` JSON for an account provisioned here. */
  private configOf(accountId: string): object {
    const { init } = this.accounts.get(accountId)!;
    const state = this.signerState.get(accountId)!;
    const simulated = this.contracts?.config(accountId);
    if (simulated) {
      return {
        ...simulated,
        origins: [...init.origins],
        rp_id: init.rp_id,
        intents_contract: init.intents_contract,
        poa_suffix: init.poa_suffix ?? 'omft.near',
      };
    }
    return {
      signers: structuredClone(state.signers),
      threshold: state.threshold,
      signer_epoch: state.epoch.toString(),
      origins: [...init.origins],
      rp_id: init.rp_id,
      recovery_key_set: init.recovery_key !== null,
      recovery_key_epoch: '0',
      intents_contract: init.intents_contract,
      poa_suffix: init.poa_suffix ?? 'omft.near',
    };
  }

  private maybeThrow(kind: Kind): void {
    if (this.throws[kind].length > 0) throw this.throws[kind].shift();
  }
}
