// NEAR sweep transport (ruling R12-m): the deposit address is registered on the token by
// `relayer-near` through its own signing guard (`assertRelayerNearTransaction`), never by the
// gas-fee key. A real RelayerNearSender signs here (local key vault); only its RPC is fake.
import { describe, expect, it } from 'vitest';
import { getKeyVault } from '../keyvault/index.js';
import { RelayerNearSender, type TxResult } from '../near/client.js';
import type { NearRpc } from '../near/rpc.js';
import { NEAR_GASLESS_TOKENS } from '../near/tokens.js';
import { RELAYER_NEAR_MAX_STORAGE_DEPOSIT, decodeSigned } from '../near/tx.js';
import { LiveNearSweepChain } from './fee-sweep-chains.js';

const USDC = NEAR_GASLESS_TOKENS[0];
const TOKEN = { assetId: USDC.assetId, symbol: 'USDC', decimals: 6, contract: USDC.contract };
/** A 1Click NEAR deposit address: an implicit account (64 hex). */
const DEPOSIT = 'c0ffee'.padEnd(64, '7');
const MIN = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, as USDC/USDT on NEAR ask

function fakeRpc(opts: { registered?: boolean; min?: bigint } = {}) {
  const sent: Uint8Array[] = [];
  const rpc = {
    accessKeyNonce: async () => 7n,
    finalBlockHash: async () => new Uint8Array(32).fill(2),
    viewFunction: async (_c: string, method: string) => {
      if (method === 'storage_balance_of') return opts.registered ? { total: '1' } : null;
      if (method === 'storage_balance_bounds') return { min: String(opts.min ?? MIN) };
      throw new Error(`unexpected view ${method}`);
    },
    sendTx: async (bytes: Uint8Array, hash: string): Promise<TxResult> => {
      sent.push(bytes);
      return {
        txHash: hash,
        logs: [],
        successLogs: [],
        status: 'success',
        topLevelStatus: 'success',
      };
    },
  };
  return { rpc: rpc as unknown as NearRpc, sent };
}

describe('LiveNearSweepChain.prepare (R12-m)', () => {
  it("relayer-near's guard signs the registration of an arbitrary 1Click deposit address", async () => {
    const { rpc, sent } = fakeRpc();
    const sender = new RelayerNearSender(rpc, getKeyVault());
    await new LiveNearSweepChain(() => sender).prepare('near', TOKEN, DEPOSIT);
    expect(sent).toHaveLength(1);
    const tx = decodeSigned(sent[0]!);
    expect(tx.signerId).toBe(await sender.accountId());
    expect(tx.receiverId).toBe(USDC.contract);
    expect(tx.actions).toHaveLength(1);
    const fc = tx.actions[0]!.fields as { methodName: string; args: Uint8Array; deposit: bigint };
    expect(tx.actions[0]!.kind).toBe('functionCall');
    expect(fc.methodName).toBe('storage_deposit');
    expect(BigInt(fc.deposit)).toBe(MIN);
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args)))).toEqual({
      account_id: DEPOSIT,
      registration_only: true,
    });
  });

  it('sends nothing when the deposit address is already registered', async () => {
    const { rpc, sent } = fakeRpc({ registered: true });
    await new LiveNearSweepChain(() => new RelayerNearSender(rpc, getKeyVault())).prepare(
      'near',
      TOKEN,
      DEPOSIT,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses a storage minimum above the relayer-near cap (nothing signed)', async () => {
    const { rpc, sent } = fakeRpc({ min: RELAYER_NEAR_MAX_STORAGE_DEPOSIT + 1n });
    await expect(
      new LiveNearSweepChain(() => new RelayerNearSender(rpc, getKeyVault())).prepare(
        'near',
        TOKEN,
        DEPOSIT,
      ),
    ).rejects.toThrow(/storage_balance_bounds/);
    expect(sent).toHaveLength(0);
  });
});
