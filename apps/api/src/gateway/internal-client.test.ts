import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { internalClient } from './internal-client.js';

const TOKEN = 'w'.repeat(40);

const req = (headers: Record<string, string>, ip = '10.0.0.5') =>
  ({ headers, ip }) as unknown as FastifyRequest;

describe('internalClient', () => {
  afterEach(() => {
    loadEnv();
  });

  it('is trusted with the right token and takes a valid client ip header', () => {
    loadEnv({ ...process.env, WEB_INTERNAL_TOKEN: TOKEN });
    expect(
      internalClient(req({ 'x-tendr-internal': TOKEN, 'x-tendr-client-ip': '203.0.113.7' })),
    ).toEqual({ trusted: true, clientIp: '203.0.113.7' });
    expect(
      internalClient(req({ 'x-tendr-internal': TOKEN, 'x-tendr-client-ip': '2001:db8::1' })),
    ).toEqual({ trusted: true, clientIp: '2001:db8::1' });
  });

  it('client ip header ignored without a valid token', () => {
    loadEnv({ ...process.env, WEB_INTERNAL_TOKEN: TOKEN });
    const ip = { 'x-tendr-client-ip': '203.0.113.7' };
    expect(internalClient(req(ip))).toEqual({ trusted: false, clientIp: '10.0.0.5' });
    expect(internalClient(req({ ...ip, 'x-tendr-internal': 'x'.repeat(40) }))).toEqual({
      trusted: false,
      clientIp: '10.0.0.5',
    });
    // A different length never reaches the constant-time compare (it would throw).
    expect(internalClient(req({ ...ip, 'x-tendr-internal': TOKEN.slice(1) }))).toEqual({
      trusted: false,
      clientIp: '10.0.0.5',
    });
  });

  it('is never trusted when no token is configured', () => {
    loadEnv({ ...process.env, WEB_INTERNAL_TOKEN: '' });
    expect(
      internalClient(req({ 'x-tendr-internal': '', 'x-tendr-client-ip': '203.0.113.7' })),
    ).toEqual({ trusted: false, clientIp: '10.0.0.5' });
  });

  it('invalid client ip header falls back to req.ip', () => {
    loadEnv({ ...process.env, WEB_INTERNAL_TOKEN: TOKEN });
    for (const bad of ['not-an-ip', '203.0.113.7, 10.0.0.1', '', '999.1.1.1']) {
      expect(internalClient(req({ 'x-tendr-internal': TOKEN, 'x-tendr-client-ip': bad }))).toEqual({
        trusted: true,
        clientIp: '10.0.0.5',
      });
    }
  });
});
