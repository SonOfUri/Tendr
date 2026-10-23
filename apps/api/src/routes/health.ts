import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  app.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch {
      return reply.status(503).send({ status: 'not_ready', database: 'down' });
    }
  });
};
