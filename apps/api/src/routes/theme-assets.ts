// Theme assets API (spec §10): upload (multipart: `kind` and `file`), list, delete.
// Same auth as themes: a secret key needs `themes:read` / `themes:write`; a dashboard user reads
// with `account:read` and writes with `settings:manage`. Assets are shared by both modes.
//
// The multipart body is read whole into `req.rawBody` before validation (ruling R16), like JSON
// bodies, so request signing and Idempotency-Key hashing cover the real uploaded bytes. It is
// then parsed from that buffer with busboy.
import { ThemeAssetKindSchema } from '@tendr/contracts';
import busboy from 'busboy';
import type { FastifyPluginAsync } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
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

/** Largest upload request: the largest file (an image, 2 MB) plus room for the form framing. */
export const UPLOAD_REQUEST_MAX_BYTES = RASTER_MAX_BYTES + 100 * 1024;

const KindSchema = z.object({ kind: ThemeAssetKindSchema });

const badUpload = (message: string) => new AppError('VALIDATION_ERROR', message, 400);
const tooLarge = () => new AppError('ASSET_INVALID', 'Files can be at most 2 MB', 400);
const oneFile = () => badUpload('Send exactly one file, in the `file` field');

type Upload = { fields: Record<string, string>; file: { filename: string; buf: Buffer } | null };

/** Parses a buffered multipart/form-data body: at most one file (≤ 2 MB) and a few small fields. */
function parseUpload(headers: IncomingHttpHeaders, body: Buffer): Promise<Upload> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers,
        limits: { fileSize: RASTER_MAX_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 64 },
      });
    } catch {
      return reject(badUpload('Send the upload as multipart/form-data'));
    }
    const fields: Record<string, string> = {};
    let file: Upload['file'] = null;
    let failure: AppError | null = null;
    const fail = (err: AppError) => (failure ??= err);
    bb.on('file', (name, stream, info) => {
      if (name !== 'file' || file) {
        fail(oneFile());
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => fail(tooLarge()));
      stream.on('end', () => {
        file = { filename: info.filename ?? '', buf: Buffer.concat(chunks) };
      });
    });
    bb.on('field', (name, value, info) => {
      if (info.valueTruncated) fail(badUpload(`The ${name} field is too long`));
      fields[name] = value;
    });
    bb.on('filesLimit', () => fail(oneFile()));
    bb.on('fieldsLimit', () => fail(badUpload('Too many form fields')));
    bb.on('partsLimit', () => fail(badUpload('Too many form parts')));
    bb.on('error', () => reject(badUpload('The multipart body is malformed')));
    bb.on('close', () => (failure ? reject(failure) : resolve({ fields, file })));
    bb.end(body);
  });
}

export const themeAssetRoutes: FastifyPluginAsync<{ store: ObjectStore }> = async (app, opts) => {
  // Encapsulated: only these routes accept multipart bodies, buffered so the gateway's signature
  // and idempotency checks see the bytes (an oversized request is a 413 before any parsing).
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: UPLOAD_REQUEST_MAX_BYTES },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      done(null, body);
    },
  );

  const assetCtx = (ctx: ReturnType<typeof ctxOf>): AssetCtx => ({ ...ctx, store: opts.store });

  app.post('/v1/theme-assets', { config: { auth: write } }, async (req, reply) => {
    const ctx = assetCtx(ctxOf(req, 'settings:manage'));
    if (!Buffer.isBuffer(req.body)) throw badUpload('Send the upload as multipart/form-data');
    const { fields, file } = await parseUpload(req.headers, req.body);
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
