import type { FastifyPluginAsync } from 'fastify';
import { PaginationQuerySchema } from '@tendr/contracts';
import { requireMerchant } from '../plugins/auth.js';
import { getPayment, listMerchantPayments } from '../services/checkout.js';
import { prisma } from '../lib/prisma.js';

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/payments/:paymentId', async (request) => {
    const auth = requireMerchant(request);
    const { paymentId } = request.params as { paymentId: string };
    return getPayment(auth.merchantId, paymentId);
  });

  app.get('/v1/merchants/me', async (request) => {
    const auth = requireMerchant(request);
    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: auth.merchantId } });
    return {
      id: merchant.id,
      name: merchant.name,
      slug: merchant.slug,
      createdAt: merchant.createdAt.toISOString(),
    };
  });

  app.get('/v1/merchants/me/payments', async (request) => {
    const auth = requireMerchant(request);
    const query = PaginationQuerySchema.parse(request.query);
    return listMerchantPayments(auth.merchantId, query.limit, query.cursor);
  });
};
