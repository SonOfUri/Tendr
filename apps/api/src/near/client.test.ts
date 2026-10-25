import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { afterAll, describe, expect, it } from 'vitest';
import { nearPublicKey } from '../keyvault/keys.js';
import { LocalKeyVault } from '../keyvault/local.js';
import { RpcNearClient, type InitConfigJson } from './client.js';
import { NearRpc, NearRpcError, NotBroadcastError, type RpcTransport } from './rpc.js';
import { decodeSigned, implicitAccountId } from './tx.js';

const dir = mkdtempSync(join(tmpdir(), 'tendr-near-client-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kv = new LocalKeyVault(join(dir, 'kv.json'));

const CODE_HASH = new Uint8Array(32).fill(0x42);
const BLOCK_HASH = new Uint8Array(32).fill(0x07);

const init: InitConfigJson = {
  signers: [{ id: 'per_01', keys: [{ p256: Buffer.alloc(33, 2).toString('base64') }] }],
  threshold: 1,
  recovery_key: null,
  rp_id: 'localhost',
  origins: ['http://localhost:3000'],
  intents_contract: 'intents-mock.tendr.testnet',
  poa_suffix: null,
  testnet_admin: 'tendr.testnet',
};

const okOutcome = (logs: string[] = []) => ({
  status: { SuccessValue: '' },
  transaction: { hash: 'TXHASH' },
  transaction_outcome: { id: 'TXHASH', outcome: { logs: [], status: { SuccessValue: '' } } },
  receipts_outcome: [{ id: 'R1', outcome: { logs, status: { SuccessValue: '' } } }],
});

/** Scripted JSON-RPC: answers access-key / block / query calls, records every send_tx. */
class ScriptedTransport implements RpcTransport {
  sent: { method: string; params: Record<string, unknown> }[] = [];
  requests: { method: string; params: Record<string, unknown> }[] = [];
  nonce = 100;
  sendResults: (() => unknown)[] = [];
  /** Throw this from the next `block` request (RPC down before broadcast). */
  blockError: Error | null = null;
  /** Answer queries with a JSON-RPC-level `result.error` string. */
  queryError: string | null = null;

  async request<T>(method: string, params: object): Promise<T> {
    const p = params as Record<string, unknown>;
    this.requests.push({ method, params: p });
    if (method === 'query' && this.queryError) return { error: this.queryError } as T;
    if (method === 'query' && p.request_type === 'view_access_key') {
      return { nonce: this.nonce, block_hash: bs58.encode(BLOCK_HASH) } as T;
    }
    if (method === 'query' && p.request_type === 'view_access_key_list') {
      return { keys: [] } as T;
    }
    if (method === 'query' && p.request_type === 'call_function') {
      return { result: Array.from(Buffer.from(JSON.stringify({ ok: 1 }))), logs: [] } as T;
    }
    if (method === 'block') {
      if (this.blockError) throw this.blockError;
      return { header: { hash: bs58.encode(BLOCK_HASH) } } as T;
    }
    if (method === 'send_tx') {
      this.sent.push({ method, params: p });
      const next = this.sendResults.shift();
      return (next ? await next() : okOutcome()) as T;
    }
    throw new Error(`unexpected rpc ${method}`);
  }
}

function client(t: ScriptedTransport, livemode = false) {
  return new RpcNearClient({
    rpc: new NearRpc(t),
    kv,
    config: {
      livemode,
      parentAccountId: livemode ? 'tendr.near' : 'tendr.testnet',
      intentsContractId: livemode ? 'intents.near' : 'intents-mock.tendr.testnet',
      codeHash: CODE_HASH,
    },
  });
}

const signedFrom = (t: ScriptedTransport, i = 0) =>
  decodeSigned(Buffer.from(String(t.sent[i]!.params.signed_tx_base64), 'base64'));

describe('RpcNearClient.provisionAccount', () => {
  it('provision_builds_create_transfer_useglobal_init_and_no_addkey', async () => {
    const t = new ScriptedTransport();
    const res = await client(t).provisionAccount({
      merchantId: 'mer_x',
      livemode: false,
      accountId: 'shop.tendr.testnet',
      init,
      initialBalanceYocto: 5n * 10n ** 23n,
    });
    expect(res.status).toBe('success');
    expect(t.sent).toHaveLength(1);

    const tx = signedFrom(t);
    const fundingPk = (await kv.publicKey('funding-near')).raw;
    expect(tx.signerId).toBe('tendr.testnet');
    expect(tx.receiverId).toBe('shop.tendr.testnet');
    expect(Buffer.from(tx.publicKey)).toEqual(Buffer.from(fundingPk));
    expect(tx.nonce).toBe(101n);
    expect(Buffer.from(tx.blockHash)).toEqual(Buffer.from(BLOCK_HASH));
    expect(ed25519.verify(tx.signature, tx.hashBytes, fundingPk)).toBe(true);
    expect(res.txHash).toBe('TXHASH');

    // Exactly these four, in this order — and so no AddKey.
    expect(tx.actions.map((a) => a.kind)).toEqual([
      'createAccount',
      'transfer',
      'useGlobalContract',
      'functionCall',
    ]);
    const [, transfer, useGlobal, call] = tx.actions;
    expect(transfer!.fields.deposit).toBe(5n * 10n ** 23n);
    const id = useGlobal!.fields.contractIdentifier as { CodeHash: number[] };
    expect(Object.keys(id)).toEqual(['CodeHash']);
    expect(Buffer.from(id.CodeHash)).toEqual(Buffer.from(CODE_HASH));
    expect(call!.fields).toMatchObject({
      methodName: 'new',
      deposit: 0n,
      gas: 100_000_000_000_000n,
    });
    const args = Buffer.from(call!.fields.args as number[]).toString();
    expect(JSON.parse(args)).toEqual({ config: init });
  });

  it('refuses an account that is not a direct sub-account of the mode parent', async () => {
    const t = new ScriptedTransport();
    const base = { merchantId: 'mer_x', livemode: false, init, initialBalanceYocto: 1n };
    for (const accountId of [
      'shop.tendr.near',
      'a.shop.tendr.testnet',
      'tendr.testnet',
      'Shop.tendr.testnet',
    ]) {
      await expect(client(t).provisionAccount({ ...base, accountId })).rejects.toThrow(/account/i);
    }
    expect(t.sent).toHaveLength(0);
  });

  it('refuses an init whose intents contract is not the mode intents contract', async () => {
    const t = new ScriptedTransport();
    await expect(
      client(t).provisionAccount({
        merchantId: 'mer_x',
        livemode: false,
        accountId: 'shop.tendr.testnet',
        init: { ...init, intents_contract: 'intents.near' },
        initialBalanceYocto: 1n,
      }),
    ).rejects.toThrow(/intents/);
    expect(t.sent).toHaveLength(0);
  });

  it('refuses a live account with a testnet admin or a params/client mode mismatch', async () => {
    const t = new ScriptedTransport();
    const live = { ...init, intents_contract: 'intents.near' };
    await expect(
      client(t, true).provisionAccount({
        merchantId: 'mer_x',
        livemode: true,
        accountId: 'shop.tendr.near',
        init: { ...live, testnet_admin: 'tendr.near' },
        initialBalanceYocto: 1n,
      }),
    ).rejects.toThrow(/testnet_admin/);
    await expect(
      client(t, true).provisionAccount({
        merchantId: 'mer_x',
        livemode: false,
        accountId: 'shop.tendr.near',
        init: { ...live, testnet_admin: null },
        initialBalanceYocto: 1n,
      }),
    ).rejects.toThrow(/livemode/);
    expect(t.sent).toHaveLength(0);
  });

  it('reports a failed execution outcome as failure', async () => {
    const t = new ScriptedTransport();
    t.sendResults.push(() => ({
      ...okOutcome(),
      status: { Failure: { ActionError: { kind: { AccountAlreadyExists: {} } } } },
    }));
    const res = await client(t).provisionAccount({
      merchantId: 'mer_x',
      livemode: false,
      accountId: 'shop.tendr.testnet',
      init,
      initialBalanceYocto: 1n,
    });
    expect(res.status).toBe('failure');
    expect(res.failure).toMatch(/AccountAlreadyExists/);
  });
});

describe('RpcNearClient.call', () => {
  it('signs with relayer-accounts from its implicit account, never funding-near', async () => {
    const t = new ScriptedTransport();
    t.sendResults.push(() => okOutcome(['EVENT_JSON:{"event":"proposed"}']));
    const res = await client(t).call('relayer-accounts', 'shop.tendr.testnet', 'propose', { a: 1 });
    expect(res).toMatchObject({ status: 'success', logs: ['EVENT_JSON:{"event":"proposed"}'] });

    const tx = signedFrom(t);
    const relayerPk = (await kv.publicKey('relayer-accounts')).raw;
    expect(tx.signerId).toBe(implicitAccountId(relayerPk));
    expect(tx.receiverId).toBe('shop.tendr.testnet');
    expect(Buffer.from(tx.publicKey)).toEqual(Buffer.from(relayerPk));
    expect(ed25519.verify(tx.signature, tx.hashBytes, relayerPk)).toBe(true);
    expect(tx.actions).toHaveLength(1);
    expect(tx.actions[0]).toMatchObject({
      kind: 'functionCall',
      fields: { methodName: 'propose', gas: 100_000_000_000_000n, deposit: 0n },
    });
    // The nonce lookup used the relayer key.
    const akq = t.requests.find((r) => r.params.request_type === 'view_access_key')!;
    expect(akq.params.public_key).toBe(nearPublicKey(relayerPk));
  });

  it('rejects any signer other than relayer-accounts', async () => {
    const t = new ScriptedTransport();
    await expect(
      client(t).call('funding-near' as 'relayer-accounts', 'x.tendr.testnet', 'm', {}),
    ).rejects.toThrow(/relayer-accounts/);
    expect(t.sent).toHaveLength(0);
  });

  it('refetches the nonce and retries once on InvalidNonce', async () => {
    const t = new ScriptedTransport();
    t.sendResults.push(() => {
      t.nonce = 500;
      throw Object.assign(new Error('InvalidNonce'), { type: 'InvalidNonce' });
    });
    const res = await client(t).call('relayer-accounts', 'shop.tendr.testnet', 'm', {});
    expect(res.status).toBe('success');
    expect(t.sent).toHaveLength(2);
    expect(signedFrom(t, 0).nonce).toBe(101n);
    expect(signedFrom(t, 1).nonce).toBe(501n);
  });

  it('gives up after the second InvalidNonce', async () => {
    const t = new ScriptedTransport();
    const fail = () => {
      throw Object.assign(new Error('InvalidNonce'), { type: 'InvalidNonce' });
    };
    t.sendResults.push(fail, fail);
    await expect(client(t).call('relayer-accounts', 's.tendr.testnet', 'm', {})).rejects.toThrow(
      /InvalidNonce/,
    );
    expect(t.sent).toHaveLength(2);
  });

  it('uses increasing nonces for back-to-back calls even if the node lags', async () => {
    const t = new ScriptedTransport();
    const c = client(t);
    await c.call('relayer-accounts', 's.tendr.testnet', 'm', {});
    await c.call('relayer-accounts', 's.tendr.testnet', 'm', {});
    expect(signedFrom(t, 0).nonce).toBe(101n);
    expect(signedFrom(t, 1).nonce).toBe(102n);
  });
});

describe('RpcNearClient views', () => {
  it('view decodes the JSON result and accessKeys lists keys', async () => {
    const t = new ScriptedTransport();
    expect(await client(t).view('s.tendr.testnet', 'get', {})).toEqual({ ok: 1 });
    const q = t.requests.find((r) => r.params.request_type === 'call_function')!;
    expect(q.params).toMatchObject({
      account_id: 's.tendr.testnet',
      method_name: 'get',
      finality: 'final',
    });
    expect(await client(t).accessKeys('s.tendr.testnet')).toEqual([]);
  });

  it('throws NearRpcError when a query answers with result.error', async () => {
    const t = new ScriptedTransport();
    t.queryError = 'wasm execution failed with error: MethodNotFound';
    await expect(client(t).view('s.tendr.testnet', 'nope', {})).rejects.toBeInstanceOf(
      NearRpcError,
    );
    await expect(client(t).accessKeys('s.tendr.testnet')).rejects.toThrow(/MethodNotFound/);
    await expect(client(t).call('relayer-accounts', 's.tendr.testnet', 'm', {})).rejects.toThrow(
      /MethodNotFound/,
    );
    expect(t.sent).toHaveLength(0);
  });
});

const provisionParams = {
  merchantId: 'mer_x',
  livemode: false,
  accountId: 'shop.tendr.testnet',
  init,
  initialBalanceYocto: 1n,
};

describe('RpcNearClient broadcast classification', () => {
  it('preflight fails without a code hash; provisioning then fails as NotBroadcastError', async () => {
    const t = new ScriptedTransport();
    const c = new RpcNearClient({
      rpc: new NearRpc(t),
      kv,
      config: {
        livemode: false,
        parentAccountId: 'tendr.testnet',
        intentsContractId: 'intents-mock.tendr.testnet',
      },
    });
    await expect(c.preflightProvision(provisionParams)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    await expect(c.provisionAccount(provisionParams)).rejects.toBeInstanceOf(NotBroadcastError);
    expect(t.requests).toHaveLength(0);
  });

  it('an RPC failure before send_tx is NotBroadcastError', async () => {
    const t = new ScriptedTransport();
    t.blockError = new Error('fetch failed');
    const err = await client(t)
      .provisionAccount(provisionParams)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotBroadcastError);
    expect((err as Error).cause).toBe(t.blockError);
    expect(t.sent).toHaveLength(0);
  });

  it('a node rejection of the tx (InvalidTxError) is NotBroadcastError', async () => {
    const t = new ScriptedTransport();
    t.sendResults.push(() => {
      throw Object.assign(new Error('Sender does not have enough balance'), {
        type: 'NotEnoughBalance',
      });
    });
    await expect(client(t).provisionAccount(provisionParams)).rejects.toBeInstanceOf(
      NotBroadcastError,
    );
  });

  it('a timeout after broadcast is rethrown as is (outcome unknown)', async () => {
    const t = new ScriptedTransport();
    const timeout = Object.assign(new Error('Timeout'), { type: 'TimeoutError' });
    t.sendResults.push(() => {
      throw timeout;
    });
    const err = await client(t)
      .provisionAccount(provisionParams)
      .catch((e: unknown) => e);
    expect(err).toBe(timeout);
    expect(err).not.toBeInstanceOf(NotBroadcastError);
  });
});

describe('RpcNearClient nonces under concurrency', () => {
  it('a retry after InvalidNonce never reuses a nonce handed to an in-flight call', async () => {
    const t = new ScriptedTransport(); // the node keeps reporting nonce 100 throughout
    const gate = () => {
      let open!: () => void;
      const p = new Promise<void>((r) => (open = r));
      return { p, open };
    };
    const gateA = gate();
    const gateB = gate();
    t.sendResults.push(
      async () => {
        await gateA.p;
        throw Object.assign(new Error('InvalidNonce'), { type: 'InvalidNonce' });
      },
      async () => {
        await gateB.p;
        return okOutcome();
      },
    );
    const waitSent = async (n: number) => {
      while (t.sent.length < n) await new Promise((r) => setImmediate(r));
    };
    const c = client(t);
    const a = c.call('relayer-accounts', 's.tendr.testnet', 'a', {});
    await waitSent(1);
    const b = c.call('relayer-accounts', 's.tendr.testnet', 'b', {}); // in flight
    await waitSent(2);
    gateA.open(); // A is rejected, retries while B is still in flight
    await a;
    await c.call('relayer-accounts', 's.tendr.testnet', 'c', {});
    gateB.open();
    await b;
    const nonces = t.sent.map((_, i) => signedFrom(t, i).nonce);
    expect(nonces).toEqual([101n, 102n, 103n, 104n]);
    expect(new Set(nonces).size).toBe(nonces.length);
  });
});
