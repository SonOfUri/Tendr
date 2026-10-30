import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../env.js';
import { internalClient } from './internal-client.js';

const TOKEN = 'w'.repeat(40);

const req = (headers: Record<string, string>, ip = '10.0.0.5') =>
  ({ headers, ip }) as unknown as FastifyRequest;

describe('internalClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    loadEnv();
  });

  it('warns once per request when a trusted request has no valid client ip, never logging secrets', () => {
    loadEnv({ ...process.env, WEB_INTERNAL_TOKEN: TOKEN });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const missing = req({ 'x-tendr-internal': TOKEN });
    internalClient(missing);
    internalClient(missing);
    internalClient(req({ 'x-tendr-internal': TOKEN, 'x-tendr-client-ip': 'evil-value' }));
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', clientIpHeader: 'missing' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'warn', clientIpHeader: 'invalid' });
    for (const l of lines) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain('evil-value');
    }
    // Untrusted requests and trusted ones with a valid address log nothing.
    spy.mockClear();
    internalClient(req({ 'x-tendr-client-ip': 'junk' }));
    internalClient(req({ 'x-tendr-internal': TOKEN, 'x-tendr-client-ip': '203.0.113.7' }));
    expect(spy).not.toHaveBeenCalled();
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
