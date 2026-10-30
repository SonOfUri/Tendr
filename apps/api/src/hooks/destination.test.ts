// Live-mode check that a hook destination holds contract code (spec §4.1).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { assertHookDestination, hookDeliveryFor, setHookCodeCheck } from './destination.js';

const CONTRACT = '0x00000000000000000000000000000000000c0de1';

describe('hook destination', () => {
  afterEach(() => {
    setHookCodeCheck(null);
    vi.restoreAllMocks();
  });

  it('test mode never asks a chain', async () => {
    const check = vi.fn(async () => false);
    setHookCodeCheck(check);
    await expect(assertHookDestination('base', CONTRACT, false)).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('live: an address without code is refused (400, field hook_data)', async () => {
    setHookCodeCheck(async () => false);
    const err = await hookDeliveryFor({
      livemode: true,
      merchantKind: 'integrator',
      payoutMode: 'wallet',
      chain: 'base',
      recipient: CONTRACT,
      hookData: { player: 'p-1' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { field: 'hook_data', reason: 'destination_not_contract' },
    });
  });

  it('live: a contract is accepted and remembered; an unreachable chain is a 503', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = vi.fn(async (chain: string, address: string) => {
      expect([chain, address]).toEqual(['near', 'game.near']);
      return true;
    });
    setHookCodeCheck(check);
    await assertHookDestination('near', 'game.near', true);
    await assertHookDestination('near', 'game.near', true);
    expect(check).toHaveBeenCalledTimes(1);

    setHookCodeCheck(async () => {
      throw new Error('rpc down');
    });
    const err = await assertHookDestination('base', CONTRACT, true).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503 });
  });

  it('the live check reads eth_getCode / view_account code_hash', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      const result =
        body.method === 'eth_getCode'
          ? '0x6080'
          : { code_hash: '11111111111111111111111111111111' };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
    await expect(assertHookDestination('base', CONTRACT, true)).resolves.toBeUndefined();
    // A NEAR account whose code hash is all ones has no contract.
    const err = await assertHookDestination('near', 'plain.near', true).catch((e: unknown) => e);
    expect(err).toMatchObject({ details: { reason: 'destination_not_contract' } });
    expect(calls.map((c) => c.body.method)).toEqual(['eth_getCode', 'query']);
    expect(calls[1]!.body.params).toMatchObject({
      request_type: 'view_account',
      account_id: 'plain.near',
    });
  });
});
