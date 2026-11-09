import { describe, expect, it } from 'vitest';
import { creditedAmount, creditsOf, eventLog, parseEventLog, type TxReceipt } from './events.js';
import { NearRpc, type RpcTransport } from './rpc.js';

const INTENTS = 'intents.near';
const USDC = 'nep141:usdc.near';

describe('NEP-297 parsing', () => {
  it('parses EVENT_JSON lines and ignores anything else', () => {
    expect(parseEventLog('hello')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{not json')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{"event":"x"}')).toBeNull();
    expect(parseEventLog(eventLog('nep245', '1.0.0', 'mt_mint', []))).toEqual({
      standard: 'nep245',
      version: '1.0.0',
      event: 'mt_mint',
      data: [],
    });
  });

  it('reads nep245 mt_transfer / mt_mint and nep141 ft_transfer credits', () => {
    const t = parseEventLog(
      eventLog('nep245', '1.0.0', 'mt_transfer', [
        {
          old_owner_id: 'solver.near',
          new_owner_id: 'shop.near',
          token_ids: [USDC, 'x'],
          amounts: ['10', '2'],
        },
        { new_owner_id: 'bad', token_ids: ['a'], amounts: ['1', '2'] }, // length mismatch
      ]),
    )!;
    expect(creditsOf(t, INTENTS)).toEqual([
      {
        standard: 'nep245',
        event: 'mt_transfer',
        receiver: 'shop.near',
        tokenId: USDC,
        amount: 10n,
      },
      { standard: 'nep245', event: 'mt_transfer', receiver: 'shop.near', tokenId: 'x', amount: 2n },
    ]);
    const m = parseEventLog(
      eventLog('nep245', '1.0.0', 'mt_mint', [
        { owner_id: 'shop.near', token_ids: [USDC], amounts: ['7'] },
      ]),
    )!;
    expect(creditsOf(m, INTENTS)[0]).toMatchObject({
      event: 'mt_mint',
      receiver: 'shop.near',
      amount: 7n,
    });
    const f = parseEventLog(
      eventLog('nep141', '1.0.0', 'ft_transfer', [
        { old_owner_id: 'a.near', new_owner_id: 'b.near', amount: '5' },
        { old_owner_id: 'a.near', new_owner_id: 'b.near', amount: '-5' },
      ]),
    )!;
    expect(creditsOf(f, 'usdc.near')).toEqual([
      {
        standard: 'nep141',
        event: 'ft_transfer',
        receiver: 'b.near',
        tokenId: 'usdc.near',
        amount: 5n,
      },
    ]);
  });

  it('counts only successful receipts of the expected emitter, receiver and asset', () => {
    const mint = (owner: string, token: string, amount: string) =>
      eventLog('nep245', '1.0.0', 'mt_mint', [
        { owner_id: owner, token_ids: [token], amounts: [amount] },
      ]);
    const receipts: TxReceipt[] = [
      {
        receiptId: '1',
        executorId: INTENTS,
        ok: true,
        logs: [mint('shop.near', USDC, '60'), 'noise'],
      },
      { receiptId: '2', executorId: INTENTS, ok: true, logs: [mint('shop.near', USDC, '40')] },
      { receiptId: '3', executorId: INTENTS, ok: false, logs: [mint('shop.near', USDC, '1000')] },
      {
        receiptId: '4',
        executorId: 'evil.near',
        ok: true,
        logs: [mint('shop.near', USDC, '1000')],
      },
      { receiptId: '5', executorId: INTENTS, ok: true, logs: [mint('other.near', USDC, '1000')] },
      {
        receiptId: '6',
        executorId: INTENTS,
        ok: true,
        logs: [mint('shop.near', 'nep141:x', '1000')],
      },
    ];
    expect(
      creditedAmount(receipts, { assetId: USDC, receiver: 'shop.near', intentsContract: INTENTS }),
    ).toBe(100n);

    const ft: TxReceipt[] = [
      {
        receiptId: '1',
        executorId: 'usdc.near',
        ok: true,
        logs: [
          eventLog('nep141', '1.0.0', 'ft_transfer', [
            { old_owner_id: 'r', new_owner_id: 'payout.near', amount: '9' },
          ]),
        ],
      },
      {
        receiptId: '2',
        executorId: 'fake-usdc.near',
        ok: true,
        logs: [
          eventLog('nep141', '1.0.0', 'ft_transfer', [
            { old_owner_id: 'r', new_owner_id: 'payout.near', amount: '99' },
          ]),
        ],
      },
    ];
    expect(creditedAmount(ft, { assetId: USDC, receiver: 'payout.near' })).toBe(9n);
  });
});

describe('NearRpc.txStatus', () => {
  it('maps EXPERIMENTAL_tx_status receipts and returns null for an unknown tx', async () => {
    const calls: { method: string; params: object }[] = [];
    let mode: 'ok' | 'unknown' | 'down' = 'ok';
    const transport: RpcTransport = {
      async request<T>(method: string, params: object): Promise<T> {
        calls.push({ method, params });
        if (mode === 'unknown')
          throw Object.assign(new Error('x'), { type: 'UNKNOWN_TRANSACTION' });
        if (mode === 'down') throw new Error('socket hang up');
        return {
          status: { SuccessValue: '' },
          transaction: {
            hash: 'H',
            signer_id: 'relayer.near',
            receiver_id: INTENTS,
            actions: [{ Delegate: { delegate_action: { sender_id: 'shopper.near' } } }],
          },
          transaction_outcome: {
            id: 'H',
            outcome: {
              logs: [],
              status: { SuccessReceiptId: 'r1' },
              tokens_burnt: '300',
              gas_burnt: 3,
            },
          },
          receipts_outcome: [
            {
              id: 'r1',
              outcome: {
                logs: ['a'],
                status: { SuccessValue: '' },
                executor_id: INTENTS,
                tokens_burnt: '45',
                gas_burnt: '4',
              },
            },
            { id: 'r2', outcome: { logs: ['b'], status: { Failure: {} }, executor_id: 'x.near' } },
            // Neither SuccessValue nor SuccessReceiptId: never trusted as a success.
            { id: 'r3', outcome: { logs: ['c'], status: 'Unknown', executor_id: INTENTS } },
            { id: 'r4', outcome: { logs: ['d'], status: {}, executor_id: INTENTS } },
          ],
          receipts: [{ receipt_id: 'r1', predecessor_id: 'shopper.near' }],
        } as T;
      },
    };
    const rpc = new NearRpc(transport);
    await expect(rpc.txStatus('H', INTENTS)).resolves.toEqual({
      hash: 'H',
      tokensBurnt: 345n,
      gasBurnt: 7n,
      topLevelOk: true,
      signerId: 'relayer.near',
      receiverId: INTENTS,
      delegateSenderIds: ['shopper.near'],
      receipts: [
        {
          receiptId: 'r1',
          executorId: INTENTS,
          logs: ['a'],
          ok: true,
          predecessorId: 'shopper.near',
        },
        { receiptId: 'r2', executorId: 'x.near', logs: ['b'], ok: false },
        { receiptId: 'r3', executorId: INTENTS, logs: ['c'], ok: false },
        { receiptId: 'r4', executorId: INTENTS, logs: ['d'], ok: false },
      ],
    });
    expect(calls[0]).toEqual({
      method: 'EXPERIMENTAL_tx_status',
      params: { tx_hash: 'H', sender_account_id: INTENTS, wait_until: 'FINAL' },
    });
    mode = 'unknown';
    await expect(rpc.txStatus('H', INTENTS)).resolves.toBeNull();
    mode = 'down';
    await expect(rpc.txStatus('H', INTENTS)).rejects.toThrow('socket hang up');
  });

  it('falls back to archival when the primary node does not know the tx', async () => {
    const primary: RpcTransport = {
      async request(): Promise<never> {
        throw Object.assign(new Error('Timeout error'), { type: 'TIMEOUT_ERROR' });
      },
    };
    const archival: RpcTransport = {
      async request<T>(): Promise<T> {
        return {
          status: { SuccessValue: '' },
          transaction: { hash: 'H', signer_id: 'intents.near', receiver_id: INTENTS, actions: [] },
          transaction_outcome: {
            id: 'H',
            outcome: { logs: [], status: { SuccessValue: '' }, tokens_burnt: '1', gas_burnt: 1 },
          },
          receipts_outcome: [
            {
              id: 'r1',
              outcome: {
                logs: ['ok'],
                status: { SuccessValue: '' },
                executor_id: INTENTS,
                tokens_burnt: '1',
                gas_burnt: 1,
              },
            },
          ],
          receipts: [],
        } as T;
      },
    };
    const rpc = new NearRpc(primary, archival);
    await expect(rpc.txStatus('H', INTENTS)).resolves.toMatchObject({
      hash: 'H',
      signerId: 'intents.near',
      receipts: [{ receiptId: 'r1', executorId: INTENTS, logs: ['ok'], ok: true }],
    });
  });
});
