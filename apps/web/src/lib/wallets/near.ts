// NEAR deposits through NEAR Wallet Selector (Meteor and Intear, both popup wallets; no redirect
// wallets, which would leave the checkout). One transaction to the token contract:
//
// 1. `storage_deposit` (registration_only, the contract's `storage_balance_bounds().min`) when the
//    deposit address is not registered on the token (`storage_balance_of` is null);
// 2. wNEAR only: `near_deposit` wrapping exactly the shortfall when the shopper's wNEAR balance is
//    below the amount (plus their own registration if they have none), so NEAR holders can pay;
// 3. `ft_transfer` of the exact amount (1 yoctoNEAR attached, as NEP-141 requires).
//
// 1Click lists NEAR as wNEAR (`nep141:wrap.near`), so the asset sent is always the quote's token.
import { WalletError, afterSignError, toWalletError } from './errors';
import type { DepositRequest, PayTarget, WalletAdapter } from './index';
import { assertDepositMatches } from './match';
import { createNearGasless, type NearSignDelegate } from './gasless/near';

/** A read-only contract call (`view`): the parsed JSON result. */
export type NearView = (
  contract: string,
  method: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface NearFunctionCall {
  type: 'FunctionCall';
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
}

export interface NearPlan {
  receiverId: string;
  actions: NearFunctionCall[];
}

export interface NearWalletLike {
  signIn(params: object): Promise<{ accountId: string }[]>;
  getAccounts(): Promise<{ accountId: string }[]>;
  signOut(): Promise<void>;
  signAndSendTransaction(params: {
    signerId?: string;
    receiverId: string;
    actions: NearFunctionCall[];
  }): Promise<unknown>;
  /** Signs a NEP-366 delegate action (gasless); absent when the wallet cannot. */
  signDelegate?: NearSignDelegate;
}

export interface NearDeps {
  /** The wallets the shopper can choose from. */
  wallets(): Promise<{ id: string; name: string }[]>;
  pickWallet(wallets: { id: string; name: string }[]): Promise<string | null>;
  wallet(id: string): Promise<NearWalletLike>;
  view: NearView;
}

const TGAS = 1_000_000_000_000n;
const GAS_STORAGE = (30n * TGAS).toString();
const GAS_WRAP = (10n * TGAS).toString();
const GAS_TRANSFER = (30n * TGAS).toString();
const UINT = /^[0-9]{1,40}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function uint(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !UINT.test(v))
    throw new WalletError('failed', { detail: `bad ${what}` });
  return BigInt(v);
}

const call = (
  methodName: string,
  args: Record<string, unknown>,
  gas: string,
  deposit: bigint,
): NearFunctionCall => ({
  type: 'FunctionCall',
  params: { methodName, args, gas, deposit: deposit.toString() },
});

/** The one transaction that pays `q` from `signerId`. */
export async function planNearDeposit(
  view: NearView,
  signerId: string,
  target: PayTarget,
  q: DepositRequest,
): Promise<NearPlan> {
  const amount = assertDepositMatches(target, q);
  const contract = target.contract;
  if (!contract) throw new WalletError('failed', { detail: 'no token contract' });
  let min: bigint | null = null;
  const storageMin = async () => {
    if (min === null) {
      const b = (await view(contract, 'storage_balance_bounds', {})) as { min?: unknown } | null;
      min = uint(b?.min, 'storage bounds');
    }
    return min;
  };
  const registered = async (account: string) =>
    (await view(contract, 'storage_balance_of', { account_id: account })) !== null;

  const actions: NearFunctionCall[] = [];
  if (!(await registered(q.depositAddress))) {
    actions.push(
      call(
        'storage_deposit',
        { account_id: q.depositAddress, registration_only: true },
        GAS_STORAGE,
        await storageMin(),
      ),
    );
  }
  if (contract === 'wrap.near') {
    const senderRegistered = await registered(signerId);
    const balance = senderRegistered
      ? uint(await view(contract, 'ft_balance_of', { account_id: signerId }), 'balance')
      : 0n;
    if (balance < amount) {
      const attach = amount - balance + (senderRegistered ? 0n : await storageMin());
      actions.push(call('near_deposit', {}, GAS_WRAP, attach));
    }
  }
  actions.push(
    call(
      'ft_transfer',
      { receiver_id: q.depositAddress, amount: amount.toString() },
      GAS_TRANSFER,
      1n,
    ),
  );
  return { receiverId: contract, actions };
}

function hashOf(outcome: unknown): string | null {
  const o = outcome as {
    transaction?: { hash?: unknown };
    transaction_outcome?: { id?: unknown };
  } | null;
  const h = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  return typeof h === 'string' && TX_HASH.test(h) ? h : null;
}

/** The execution outcome reports a failure (the transaction's or any receipt's). */
function failedOnChain(outcome: unknown): boolean {
  const o = outcome as {
    status?: unknown;
    receipts_outcome?: { outcome?: { status?: unknown } }[];
  } | null;
  const failed = (st: unknown) => typeof st === 'object' && st !== null && 'Failure' in st;
  if (failed(o?.status)) return true;
  return Array.isArray(o?.receipts_outcome)
    ? o!.receipts_outcome.some((r) => failed(r?.outcome?.status))
    : false;
}

export function createNearAdapter(target: PayTarget, deps: NearDeps): WalletAdapter {
  if (target.family !== 'near') throw new WalletError('failed', { detail: 'not a NEAR asset' });
  let wallet: NearWalletLike | null = null;
  let accountId: string | null = null;
  return {
    chainFamily: 'near',
    gasless: createNearGasless(target, {
      address: () => accountId,
      signDelegate: () => wallet?.signDelegate ?? null,
    }),
    async connect() {
      try {
        const options = await deps.wallets();
        const id = await deps.pickWallet(options);
        if (!id) throw new WalletError('rejected');
        const w = await deps.wallet(id);
        let accounts = await w.getAccounts().catch(() => []);
        if (accounts.length === 0) accounts = await w.signIn({});
        const a = accounts[0]?.accountId;
        if (!a) throw new WalletError('failed', { detail: 'no account' });
        wallet = w;
        accountId = a;
        return { address: a };
      } catch (err) {
        throw toWalletError(err);
      }
    },
    async sendDeposit(q) {
      if (!wallet || !accountId) throw new WalletError('failed', { detail: 'not connected' });
      assertDepositMatches(target, q);
      if (accountId.endsWith('.testnet'))
        throw new WalletError('chain_mismatch', { network: 'NEAR' });
      // Planning (contract views) happens before the wallet is asked to sign: its errors are
      // plain failures. A throw from the wallet's sign-and-send is possibly sent (C33).
      let plan: NearPlan;
      try {
        plan = await planNearDeposit(deps.view, accountId, target, q);
      } catch (err) {
        throw err instanceof WalletError
          ? err
          : new WalletError('failed', { cause: err, detail: 'planning failed' });
      }
      let outcome: unknown;
      try {
        outcome = await wallet.signAndSendTransaction({ signerId: accountId, ...plan });
      } catch (err) {
        throw afterSignError(err);
      }
      // The wallet returned an outcome: from here on, never a plain retry (C32).
      const hash = hashOf(outcome);
      if (!hash) throw new WalletError('uncertain', { detail: 'no transaction hash' });
      if (failedOnChain(outcome)) {
        throw new WalletError('onchain_failed', { txHash: hash, detail: 'transaction failed' });
      }
      return { txHash: hash };
    },
    async disconnect() {
      const w = wallet;
      wallet = null;
      accountId = null;
      if (w) await w.signOut().catch(() => {});
    },
  };
}

const NEAR_RPC = 'https://free.rpc.fastnear.com';

/** A `view` over NEAR JSON-RPC (`query` / `call_function`, final). */
export function rpcView(rpcUrl: string = NEAR_RPC, fetchFn: typeof fetch = fetch): NearView {
  return async (contract, method, args) => {
    const bytes = new TextEncoder().encode(JSON.stringify(args));
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'tendr',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: contract,
          method_name: method,
          args_base64: btoa(bin),
        },
      }),
    });
    const body = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
    if (!res.ok || body.error || !Array.isArray(body.result?.result)) {
      throw new WalletError('failed', { detail: 'NEAR view failed' });
    }
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result!.result!)));
  };
}

/** The real dependencies: Wallet Selector on mainnet with Meteor and Intear. */
export function nearSelectorDeps(
  pickWallet: (wallets: { id: string; name: string }[]) => Promise<string | null>,
  testnet = false,
): NearDeps {
  let selector: Promise<{
    wallet(id: string): Promise<unknown>;
    store: {
      getState(): { modules: { id: string; metadata: { name: string; available?: boolean } }[] };
    };
  }> | null = null;
  const load = () => {
    if (!selector) {
      selector = (async () => {
        const [{ setupWalletSelector }, { setupMeteorWallet }, { setupIntearWallet }] =
          await Promise.all([
            import('@near-wallet-selector/core'),
            import('@near-wallet-selector/meteor-wallet'),
            import('@near-wallet-selector/intear-wallet'),
          ]);
        return setupWalletSelector({
          network: testnet ? 'testnet' : 'mainnet',
          modules: [setupMeteorWallet(), setupIntearWallet()],
        }) as never;
      })().catch((err: unknown) => {
        selector = null;
        throw err;
      });
    }
    return selector;
  };
  return {
    async wallets() {
      const s = await load();
      return s.store
        .getState()
        .modules.filter((m) => m.metadata.available !== false)
        .map((m) => ({ id: m.id, name: m.metadata.name }));
    },
    pickWallet,
    async wallet(id) {
      const [s, { internalActionToNaj }] = await Promise.all([
        load(),
        import('@near-wallet-selector/core'),
      ]);
      const w = (await s.wallet(id)) as {
        signIn(p: object): Promise<{ accountId: string }[]>;
        getAccounts(): Promise<{ accountId: string }[]>;
        signOut(): Promise<void>;
        signAndSendTransaction(p: object): Promise<unknown>;
      };
      // No `signDelegate`: Meteor and Intear (wallet-selector 10.1.4) throw "Method not supported"
      // for `signDelegateAction`, so NEAR shoppers pay normally until a wallet module signs
      // delegate actions with a full-access key (ruling T10-e).
      return {
        signIn: (p) => w.signIn(p),
        getAccounts: () => w.getAccounts(),
        signOut: () => w.signOut(),
        signAndSendTransaction: ({ signerId, receiverId, actions }) =>
          w.signAndSendTransaction({
            signerId,
            receiverId,
            actions: actions.map((a) => internalActionToNaj(a)),
          }),
      };
    },
    view: rpcView(testnet ? 'https://rpc.testnet.fastnear.com' : NEAR_RPC),
  };
}
