// Theme assets API (spec §10): upload (multipart: `kind` and `file`), list, delete.
// Same auth as themes: a secret key needs `themes:read` / `themes:write`; a dashboard user reads
// with `account:read` and writes with `settings:manage`. Assets are shared by both modes.
import multipart from '@fastify/multipart';
import { ThemeAssetKindSchema } from '@tendr/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import type { ObjectStore } from '../storage/object-store.js';
import {
  deleteThemeAsset,
  listThemeAssets,
  RASTER_MAX_BYTES,
  uploadThemeAsset,
  type AssetCtx,
} from '../themes/assets.js';
import { ctxOf } from './themes.js';

const principals = ['dashboard_user' as const, 'secret_key' as const];
const read = { principals, scope: 'themes:read' as const };
const write = { principals, scope: 'themes:write' as const };

const KindSchema = z.object({ kind: ThemeAssetKindSchema });

const badUpload = (message: string) => new AppError('VALIDATION_ERROR', message, 400);
const FILE_TOO_LARGE = 'FST_REQ_FILE_TOO_LARGE';

export const themeAssetRoutes: FastifyPluginAsync<{ store: ObjectStore }> = async (app, opts) => {
  // Encapsulated: only these routes accept multipart bodies. No upload is ever larger than an
  // image (fonts and SVGs have smaller caps, checked by the service).
  await app.register(multipart, {
    limits: { fileSize: RASTER_MAX_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 64 },
  });

  const assetCtx = (ctx: ReturnType<typeof ctxOf>): AssetCtx => ({ ...ctx, store: opts.store });

  app.post('/v1/theme-assets', { config: { auth: write } }, async (req, reply) => {
    const ctx = assetCtx(ctxOf(req, 'settings:manage'));
    if (!req.isMultipart()) throw badUpload('Send the upload as multipart/form-data');
    const fields: Record<string, unknown> = {};
    let file: { filename: string; buf: Buffer } | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || file) {
            part.file.resume();
            throw badUpload('Send exactly one file, in the `file` field');
          }
          file = { filename: part.filename, buf: await part.toBuffer() };
        } else {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (err) {
      if ((err as { code?: unknown }).code === FILE_TOO_LARGE) {
        throw new AppError('ASSET_INVALID', 'Files can be at most 2 MB', 400);
      }
      throw err;
    }
    const { kind } = KindSchema.parse(fields);
    if (!file) throw badUpload('Send the file in the `file` field');
    return reply.status(201).send(await uploadThemeAsset(ctx, { kind, ...file }));
  });

  app.get('/v1/theme-assets', { config: { auth: read } }, async (req) =>
    listThemeAssets(assetCtx(ctxOf(req, 'account:read'))),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/theme-assets/:id',
    { config: { auth: write } },
    async (req) => deleteThemeAsset(assetCtx(ctxOf(req, 'settings:manage')), req.params.id),
  );
};
