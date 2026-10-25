// In-memory NearClient for API tests and offline local dev: no network, no signing. It records
// every call (args deep-copied), returns scripted logs / view results, and tracks provisioned
// accounts (which, like real merchant accounts, have no access keys).
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import type {
  CallOptions,
  InitConfigJson,
  NearClient,
  ProvisionParams,
  TxResult,
} from './client.js';
import { assertProvisionable, type ProvisionScope } from './provision.js';
import { DEFAULT_CALL_GAS } from './tx.js';

export type FakeCall =
  | {
      kind: 'call';
      signer: 'relayer-accounts';
      contractId: string;
      method: string;
      args: object;
      gas: bigint;
      deposit: bigint;
    }
  | { kind: 'view'; contractId: string; method: string; args: object }
  | { kind: 'provision'; accountId: string; init: InitConfigJson; initialBalanceYocto: bigint };

type Kind = FakeCall['kind'];
type Scripted<T> = T | ((args: object) => T);

const fakeHash = (): string => bs58.encode(randomBytes(32));
const key = (contractId: string, method: string): string => `${contractId}#${method}`;

export class FakeNearClient implements NearClient {
  readonly calls: FakeCall[] = [];
  readonly accounts = new Map<string, { init: InitConfigJson; balanceYocto: bigint }>();
  private readonly logs = new Map<string, Scripted<string[]>>();
  private readonly views = new Map<string, (args: object) => unknown>();
  private readonly keys = new Map<string, string[]>();
  private readonly failures = new Map<string, string[]>();
  private readonly downstreamFailures = new Map<string, string[]>();
  private readonly provisionFailures: string[] = [];
  private readonly throws: Record<Kind, unknown[]> = { call: [], view: [], provision: [] };

  constructor(readonly scope: ProvisionScope) {}

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
   */
  failDownstreamNext(method: string, failure: string): void {
    this.downstreamFailures.set(method, [
      ...(this.downstreamFailures.get(method) ?? []),
      failure,
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
        status: 'failure',
        topLevelStatus: 'failure',
        failure,
      };
    }
    const scripted = this.logs.get(key(contractId, method));
    const logs = typeof scripted === 'function' ? scripted(args) : (scripted ?? []);
    const downstream = this.downstreamFailures.get(method)?.shift();
    if (downstream !== undefined) {
      return {
        txHash: fakeHash(),
        logs,
        status: 'failure',
        topLevelStatus: 'success',
        failure: downstream,
      };
    }
    return { txHash: fakeHash(), logs, status: 'success', topLevelStatus: 'success' };
  }

  async view<T>(contractId: string, method: string, args: object): Promise<T> {
    this.calls.push({ kind: 'view', contractId, method, args: structuredClone(args) });
    this.maybeThrow('view');
    const k = key(contractId, method);
    const answer = this.views.get(k);
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
      return { txHash: fakeHash(), logs: [], status: 'failure', topLevelStatus: 'failure', failure };
    }
    this.accounts.set(p.accountId, {
      init: structuredClone(p.init),
      balanceYocto: p.initialBalanceYocto,
    });
    return { txHash: fakeHash(), logs: [], status: 'success', topLevelStatus: 'success' };
  }

  async accessKeys(accountId: string): Promise<string[]> {
    const scripted = this.keys.get(accountId);
    if (scripted) return [...scripted];
    if (!this.accounts.has(accountId)) {
      throw new Error(`FakeNearClient: account ${accountId} does not exist`);
    }
    return [];
  }

  private maybeThrow(kind: Kind): void {
    if (this.throws[kind].length > 0) throw this.throws[kind].shift();
  }
}
