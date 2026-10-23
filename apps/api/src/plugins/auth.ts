import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export type MerchantAuth = {
  merchantId: string;
  apiKeyId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    merchantAuth?: MerchantAuth;
  }
}

const authPluginImpl: FastifyPluginAsync = async (app) => {
  app.decorateRequest('merchantAuth', undefined);

  app.addHook('preHandler', async (request) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (!path.startsWith('/v1/')) return;
    if (path === '/v1/openapi.json') return;

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Missing Bearer API key');
    }
    const raw = header.slice('Bearer '.length).trim();
    const keyHash = sha256(raw);
    const apiKey = await prisma.apiKey.findFirst({
      where: { keyHash, revokedAt: null },
    });
    if (!apiKey) throw unauthorized('Invalid API key');

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    });

    request.merchantAuth = { merchantId: apiKey.merchantId, apiKeyId: apiKey.id };
  });
};

/** Break Fastify encapsulation so the auth hook applies to sibling route plugins. */
export const authPlugin = fp(authPluginImpl, { name: 'tendr-auth' });

export function requireMerchant(request: FastifyRequest): MerchantAuth {
  if (!request.merchantAuth) throw unauthorized();
  return request.merchantAuth;
}
