// Brand pull (spec §7) and the connected store's brand:
// - `POST /v1/themes/from-website` `{ url, name? }` and `POST /v1/themes/from-store`
//   `{ connection_id, name? }` create a DRAFT theme (201); they never publish. Same auth as theme
//   writes (`themes:write`, or a dashboard user with `settings:manage`), plus `brand_pull`: 10 per
//   merchant per hour, whoever calls.
// - `PUT /v1/connection/brand` stores the brand a connected WooCommerce store sends (site name,
//   logo and icon URLs, palette). Only a connection key (a `secret_key` issued by Connect); any
//   other principal is 403.
import {
  ConnectionBrandSchema,
  ThemeFromStoreSchema,
  ThemeFromWebsiteSchema,
} from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requirePrincipal } from '../gateway/principal.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import { themeFromStore, themeFromWebsite, type BrandCtx } from '../themes/brand.js';
import { ctxOf } from './themes.js';

const principals = ['dashboard_user' as const, 'secret_key' as const];
const write = { principals, scope: 'themes:write' as const };
/** Any principal that might call is let in, so every one but a connection key gets a 403. */
const connectionOnly = { principals: ['secret_key' as const, 'dashboard_user' as const] };

export const themeBrandRoutes: FastifyPluginAsync<{
  store: ObjectStore;
  /** The `brand_pull` limiter; run once the caller is known to be allowed to pull. */
  brandPullRateLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (app, opts) => {
  /** The caller's theme context (permission checked), then one pull counted against the store. */
  const brandCtx = async (req: FastifyRequest, reply: FastifyReply): Promise<BrandCtx> => {
    const ctx = { ...ctxOf(req, 'settings:manage'), store: opts.store };
    await opts.brandPullRateLimit(req, reply);
    return ctx;
  };
  const pull = { config: { auth: write } };

  app.post('/v1/themes/from-website', pull, async (req, reply) => {
    const input = ThemeFromWebsiteSchema.parse(req.body ?? {});
    const ctx = await brandCtx(req, reply);
    return reply.status(201).send(await themeFromWebsite(ctx, input));
  });

  app.post('/v1/themes/from-store', pull, async (req, reply) => {
    const input = ThemeFromStoreSchema.parse(req.body ?? {});
    const ctx = await brandCtx(req, reply);
    return reply.status(201).send(await themeFromStore(ctx, input));
  });

  app.put('/v1/connection/brand', { config: { auth: connectionOnly } }, async (req) => {
    const p = requirePrincipal(req);
    if (p.kind !== 'secret_key' || !p.connectionId) {
      throw forbidden('This endpoint needs a connection key');
    }
    if (!req.db) throw unauthorized();
    const brand = ConnectionBrandSchema.parse(req.body ?? {});
    const row = await req.db.connection.update({
      where: { id: p.connectionId },
      data: { brand, brandUpdatedAt: new Date() },
      select: { id: true, brandUpdatedAt: true },
    });
    return {
      connection_id: row.id,
      brand,
      brand_updated_at: row.brandUpdatedAt!.toISOString(),
    };
  });
};
