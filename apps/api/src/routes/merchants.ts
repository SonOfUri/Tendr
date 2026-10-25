// Stores: creation at signup and lookup for the signed-in person.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePerson } from '../gateway/principal.js';
import { createStore } from '../merchants/signup.js';
import { storeFor } from '../merchants/team.js';

export const merchantRoutes: FastifyPluginAsync = async (app) => {
  // A person with no store selected creates one; they become its owner and first signer.
  app.post(
    '/v1/merchants',
    { config: { auth: { principals: ['user_session'] } } },
    async (req, reply) => {
      const { userId } = requirePerson(req);
      const { name } = z
        .object({ name: z.string().trim().min(1).max(100) })
        .strict()
        .parse(req.body);
      const { merchant } = await createStore(userId, name);
      return reply.status(201).send(await storeFor(userId, merchant.id));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/merchants/:id',
    { config: { auth: { principals: ['user_session', 'dashboard_user'] } } },
    async (req) => storeFor(requirePerson(req).userId, req.params.id),
  );
};
