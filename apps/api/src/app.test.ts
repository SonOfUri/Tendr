import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, requestIdFor } from './app.js';
import { prisma } from './lib/prisma.js';
import { createMerchant, resetDb } from './test/helpers.js';

describe('app', () => {
  let app: FastifyInstance;
  let slug: string;

  beforeAll(async () => {
    await resetDb();
    slug = (await createMerchant()).slug;
    app = await buildApp({
      extraRoutes: (a) => {
        // Non-/v1 test routes: no auth, so they reach the Prisma calls directly.
        a.post('/test/duplicate', async () =>
          prisma.merchant.create({ data: { id: 'mer_dup', name: 'dup', slug } }),
        );
        a.post('/test/missing', async () =>
          prisma.merchant.update({ where: { id: 'mer_missing' }, data: { name: 'x' } }),
        );
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('x-request-id', () => {
    it('echoes a well-formed client request id', async () => {
      const id = 'req_01.abc:DEF-9';
      const res = await app.inject({ url: '/v1/health', headers: { 'x-request-id': id } });
      expect(res.headers['x-request-id']).toBe(id);
    });

    it.each([
      ['too long', 'a'.repeat(129)],
      ['spaces', 'has space'],
      ['other characters', 'id<script>'],
      ['empty', ''],
    ])('replaces a client request id with %s by a fresh one', async (_label, bad) => {
      const res = await app.inject({ url: '/v1/health', headers: { 'x-request-id': bad } });
      expect(res.headers['x-request-id']).not.toBe(bad);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('generates an id when none is sent; accepts exactly 128 characters', async () => {
      expect(requestIdFor(undefined)).toMatch(/^[0-9a-f-]{36}$/);
      expect(requestIdFor(['a', 'b'])).toMatch(/^[0-9a-f-]{36}$/);
      expect(requestIdFor('a'.repeat(128))).toBe('a'.repeat(128));
    });
  });

  describe('Prisma errors', () => {
    it('a unique violation (P2002) is 409 CONFLICT with a fixed message', async () => {
      const res = await app.inject({ method: 'POST', url: '/test/duplicate' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toEqual({
        code: 'CONFLICT',
        message: 'Resource already exists',
        requestId: res.headers['x-request-id'],
      });
    });

    it('a missing row (P2025) is 404 NOT_FOUND with a fixed message', async () => {
      const res = await app.inject({ method: 'POST', url: '/test/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toEqual({
        code: 'NOT_FOUND',
        message: 'Resource not found',
        requestId: res.headers['x-request-id'],
      });
    });
  });
});
