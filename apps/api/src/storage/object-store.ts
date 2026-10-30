// Where theme assets (and later product images) are stored: an S3-compatible bucket (MinIO in
// development, R2/S3 in production) served publicly from TENDR_ASSET_ORIGIN, or an in-memory map
// in tests. Keys are never reused (a new upload gets a new id), so objects are cached forever.
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env, type Env } from '../env.js';

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
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
  };
}

/** The store `ASSET_STORE_DRIVER` names (env.ts checks the s3 settings are present). */
export function createObjectStore(env: Env): ObjectStore {
  if (env.ASSET_STORE_DRIVER === 'memory') return memoryObjectStore();
  const client = new S3Client({
    region: env.ASSET_S3_REGION,
    ...(env.ASSET_S3_ENDPOINT ? { endpoint: env.ASSET_S3_ENDPOINT } : {}),
    forcePathStyle: env.ASSET_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.ASSET_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.ASSET_S3_SECRET_ACCESS_KEY!,
    },
  });
  return s3ObjectStore(client, env.ASSET_S3_BUCKET!);
}
