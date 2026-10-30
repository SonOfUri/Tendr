// Checkout themes API (spec §10): presets, list, create, read, edit the draft, delete, publish,
// make default, validate.
// - A secret key needs `themes:read` / `themes:write` (checked by the gateway).
// - A dashboard user reads with `account:read` and writes with `settings:manage`.
// - Themes are shared by both modes, so publishing and changing the default (what live shoppers
//   see) need a live key or a dashboard user, who also needs step-up. A test key gets 403.
// - Drafts are checked by the theme validator, not the route: a bad document is THEME_INVALID
//   (400) with `details.problems` as `[{ path, message }]`.
import { ThemeCreateSchema } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireMerchantPrincipal, requirePrincipal, requireStepUp } from '../gateway/principal.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import {
  createTheme,
  deleteTheme,
  getTheme,
  listPresets,
  listThemes,
  publishTheme,
  setDefaultTheme,
  updateThemeDraft,
  validateOnly,
  type ThemeCtx,
} from '../themes/themes.js';
import { check, denied } from './merchant-settings.js';

const principals = ['dashboard_user' as const, 'secret_key' as const];
const read = { principals, scope: 'themes:read' as const };
const write = { principals, scope: 'themes:write' as const };

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().min(1).optional(),
});

/** The draft is checked by the validator (paths and plain reasons), so it is taken as-is here. */
const UpdateBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  draft: z.unknown().optional(),
});
const ValidateBodySchema = z.strictObject({ document: z.unknown() });

function ctxOf(req: FastifyRequest, permission: 'account:read' | 'settings:manage'): ThemeCtx {
  const p = requirePrincipal(req);
  if (!req.db) throw unauthorized();
  if (p.kind === 'dashboard_user') {
    if (!p.permissions.includes(permission)) {
      throw denied(req, forbidden(`Missing permission ${permission}`));
    }
  } else if (p.kind !== 'secret_key') {
    throw unauthorized();
  }
  return { merchantId: p.merchantId, db: req.db };
}

/** Publish and default change what live shoppers see: a live key, or a stepped-up dashboard user. */
function liveCtxOf(req: FastifyRequest): ThemeCtx {
  const ctx = ctxOf(req, 'settings:manage');
  const p = requireMerchantPrincipal(req);
  if (p.kind === 'dashboard_user') {
    check(req, () => requireStepUp(req));
  } else if (!p.livemode) {
    throw denied(req, forbidden('Publishing a theme or changing the default needs a live key'));
  }
  return ctx;
}

export const themeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/themes/presets', { config: { auth: read } }, async (req) =>
    listPresets(ctxOf(req, 'account:read')),
  );

  app.post('/v1/themes/validate', { config: { auth: write } }, async (req) => {
    const ctx = ctxOf(req, 'settings:manage');
    return validateOnly(ctx, ValidateBodySchema.parse(req.body ?? {}).document);
  });

  app.get('/v1/themes', { config: { auth: read } }, async (req) =>
    listThemes(ctxOf(req, 'account:read'), ListQuerySchema.parse(req.query ?? {})),
  );

  app.post('/v1/themes', { config: { auth: write } }, async (req, reply) => {
    const ctx = ctxOf(req, 'settings:manage');
    const input = ThemeCreateSchema.parse(req.body);
    return reply.status(201).send(await createTheme(ctx, input));
  });

  app.get<{ Params: { id: string } }>('/v1/themes/:id', { config: { auth: read } }, async (req) =>
    getTheme(ctxOf(req, 'account:read'), req.params.id),
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/themes/:id',
    { config: { auth: write } },
    async (req) => {
      const ctx = ctxOf(req, 'settings:manage');
      return updateThemeDraft(ctx, req.params.id, UpdateBodySchema.parse(req.body ?? {}));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/themes/:id',
    { config: { auth: write } },
    async (req) => deleteTheme(ctxOf(req, 'settings:manage'), req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/v1/themes/:id/publish',
    { config: { auth: write } },
    async (req) => publishTheme(liveCtxOf(req), req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/v1/themes/:id/default',
    { config: { auth: write } },
    async (req) => setDefaultTheme(liveCtxOf(req), req.params.id),
  );
};
