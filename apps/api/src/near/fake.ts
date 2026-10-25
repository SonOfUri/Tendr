// In-memory NearClient for API tests and offline local dev: no network, no signing. It records
// every call, returns scripted logs / view results, and tracks provisioned accounts (which, like
// real merchant accounts, have no access keys).
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

type Scripted<T> = T | ((args: object) => T);

const fakeHash = (): string => bs58.encode(randomBytes(32));
const key = (contractId: string, method: string): string => `${contractId}#${method}`;

export class FakeNearClient implements NearClient {
  readonly calls: FakeCall[] = [];
  readonly accounts = new Map<string, { init: InitConfigJson; balanceYocto: bigint }>();
  private readonly logs = new Map<string, Scripted<string[]>>();
  private readonly views = new Map<string, (args: object) => unknown>();
  private readonly failures = new Map<string, string[]>();

  constructor(readonly scope: ProvisionScope) {}

  /** Logs returned by `call(contractId, method)` (e.g. NEP-297 `EVENT_JSON:` lines). */
  scriptLogs(contractId: string, method: string, logs: Scripted<string[]>): void {
    this.logs.set(key(contractId, method), logs);
  }

  /** `view(contractId, method)` returns `answer(args)`. */
  scriptView(contractId: string, method: string, answer: (args: object) => unknown): void {
    this.views.set(key(contractId, method), answer);
  }

  /** The next `call` to `method` (any contract) returns a failure with `failure`. */
  failNext(method: string, failure: string): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
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
      args,
      gas: opts.gas ?? DEFAULT_CALL_GAS,
      deposit: opts.deposit ?? 0n,
    });
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) return { txHash: fakeHash(), logs: [], status: 'failure', failure };
    const scripted = this.logs.get(key(contractId, method));
    const logs = typeof scripted === 'function' ? scripted(args) : (scripted ?? []);
    return { txHash: fakeHash(), logs, status: 'success' };
  }

  async view<T>(contractId: string, method: string, args: object): Promise<T> {
    this.calls.push({ kind: 'view', contractId, method, args });
    const k = key(contractId, method);
    const answer = this.views.get(k);
    if (!answer) throw new Error(`FakeNearClient: no view scripted for ${k}`);
    return answer(args) as T;
  }

  async provisionAccount(p: ProvisionParams): Promise<TxResult> {
    assertProvisionable(p, this.scope);
    this.calls.push({
      kind: 'provision',
      accountId: p.accountId,
      init: p.init,
      initialBalanceYocto: p.initialBalanceYocto,
    });
    if (this.accounts.has(p.accountId)) {
      return {
        txHash: fakeHash(),
        logs: [],
        status: 'failure',
        failure: `account ${p.accountId} already exists`,
      };
    }
    this.accounts.set(p.accountId, { init: p.init, balanceYocto: p.initialBalanceYocto });
    return { txHash: fakeHash(), logs: [], status: 'success' };
  }

  async accessKeys(accountId: string): Promise<string[]> {
    if (!this.accounts.has(accountId)) {
      throw new Error(`FakeNearClient: account ${accountId} does not exist`);
    }
    return [];
  }
}
