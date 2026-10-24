import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/health', async () => ({ status: 'ok' }));

  app.get('/v1/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch {
      return reply.status(503).send({ status: 'not_ready', database: 'down' });
    }
  });
};
