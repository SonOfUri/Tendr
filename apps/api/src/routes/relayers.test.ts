// `GET /v1/relayers` (ruling R13-b): public, read-only, addresses only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { evmAddress, getKeyVault } from '../keyvault/index.js';
import { implicitAccountId } from '../near/tx.js';
import { resetRelayerList } from './relayers.js';

describe('GET /v1/relayers', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    resetRelayerList();
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('is public and lists relayer-evm per hook chain and relayer-near, from public keys only', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/relayers' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      relayers: { chain: string; family: string; chain_id: number | null; address: string }[];
    };
    const evm = evmAddress((await getKeyVault().publicKey('relayer-evm')).raw).toLowerCase();
    const near = implicitAccountId((await getKeyVault().publicKey('relayer-near')).raw);
    const base = body.relayers.find((r) => r.chain === 'base');
    expect(base).toEqual({
      chain: 'base',
      family: 'evm',
      chain_id: 8453,
      address: evm,
      calls: 'onTendrDeposit',
    });
    expect(body.relayers.find((r) => r.chain === 'near')).toEqual({
      chain: 'near',
      family: 'near',
      chain_id: null,
      address: near,
      calls: 'on_tendr_deposit',
    });
    // Every EVM entry is the same relayer-evm address; nothing but addresses is returned.
    expect(body.relayers.filter((r) => r.family === 'evm').every((r) => r.address === evm)).toBe(
      true,
    );
    expect(body.relayers.some((r) => r.chain === 'tron' || r.chain === 'sol')).toBe(false);
    for (const r of body.relayers) {
      expect(Object.keys(r).sort()).toEqual(['address', 'calls', 'chain', 'chain_id', 'family']);
    }
  });
});
