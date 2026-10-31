// Where theme assets (and later product images) are stored: an S3-compatible bucket (MinIO or a GCS
// dev bucket in development, GCS/R2/S3 in production) served from TENDR_ASSET_ORIGIN, or an in-memory
// map in tests. Theme keys are immutable; the public proxy gives replaceable product keys a shorter TTL.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { env, type Env } from '../env.js';

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Used only by the opt-in public asset proxy for private S3 buckets. */
  get?(key: string): Promise<{ body: Buffer; contentType: string; etag?: string } | null>;
}

export type MemoryObjectStore = ObjectStore & {
  objects: Map<string, { body: Buffer; contentType: string }>;
};

export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The public URL of a stored object: `TENDR_ASSET_ORIGIN/<key>`. */
export function assetUrl(key: string): string {
  return `${env().TENDR_ASSET_ORIGIN}/${key}`;
}

export function memoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async delete(key) {
      objects.delete(key);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
  };
}

export function s3ObjectStore(client: S3Client, bucket: string): ObjectStore {
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: ASSET_CACHE_CONTROL,
        }),
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async get(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) return null;
        const stream = result.Body.transformToWebStream();
        if (!result.ContentType) {
          await stream.cancel();
          return null;
        }
        // Uploaded theme files are at most 2 MB; allow room for re-encoded product images.
        const maxBytes = 4 * 1024 * 1024;
        if ((result.ContentLength ?? 0) > maxBytes) {
          await stream.cancel();
          throw new Error('Stored asset exceeds the public asset size limit');
        }
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes)
              throw new Error('Stored asset exceeds the public asset size limit');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        const body = Buffer.concat(chunks, length);
        return {
          body,
          contentType: result.ContentType,
          ...(result.ETag ? { etag: result.ETag } : {}),
        };
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          (('name' in error && error.name === 'NoSuchKey') ||
            ('$metadata' in error &&
              (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404))
        )
          return null;
        throw error;
      }
    },
  };
}

/** The store `ASSET_STORE_DRIVER` names (env.ts checks the s3 settings are present). */
export function createObjectStore(env: Env): ObjectStore {
  if (env.ASSET_STORE_DRIVER === 'memory') return memoryObjectStore();
  return s3ObjectStore(createS3Client(env), env.ASSET_S3_BUCKET!);
}

/**
 * The S3 client for the asset bucket. Checksums are computed only where an operation requires
 * them: newer SDKs add CRC headers by default, which GCS's S3 interop endpoint rejects.
 */
export function createS3Client(env: Env, overrides: Partial<S3ClientConfig> = {}): S3Client {
  return new S3Client({
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    region: env.ASSET_S3_REGION,
    ...(env.ASSET_S3_ENDPOINT ? { endpoint: env.ASSET_S3_ENDPOINT } : {}),
    forcePathStyle: env.ASSET_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.ASSET_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.ASSET_S3_SECRET_ACCESS_KEY!,
    },
    ...overrides,
  });
}
