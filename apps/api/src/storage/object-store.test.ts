import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { createObjectStore, memoryObjectStore, s3ObjectStore } from './object-store.js';

describe('object store', () => {
  it('memory store keeps puts and forgets deletes', async () => {
    const store = memoryObjectStore();
    await store.put('assets/m/a.png', Buffer.from('x'), 'image/png');
    expect(store.objects.get('assets/m/a.png')).toEqual({
      body: Buffer.from('x'),
      contentType: 'image/png',
    });
    await store.delete('assets/m/a.png');
    await store.delete('assets/m/missing.png'); // deleting nothing is fine
    expect(store.objects.size).toBe(0);
  });

  it('s3 store writes immutable public objects to the bucket', async () => {
    const sent: unknown[] = [];
    const client = { send: async (cmd: unknown) => void sent.push(cmd) } as unknown as S3Client;
    const store = s3ObjectStore(client, 'tendr-assets');
    await store.put('assets/m/a.png', Buffer.from('x'), 'image/png');
    await store.delete('assets/m/a.png');
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toEqual({
      Bucket: 'tendr-assets',
      Key: 'assets/m/a.png',
      Body: Buffer.from('x'),
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(sent[1]).toBeInstanceOf(DeleteObjectCommand);
    expect((sent[1] as DeleteObjectCommand).input).toEqual({
      Bucket: 'tendr-assets',
      Key: 'assets/m/a.png',
    });
  });

  it('createObjectStore picks the driver from env', () => {
    const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://localhost:6380' };
    const mem = createObjectStore(loadEnv({ ...base, NODE_ENV: 'test' }));
    expect('objects' in mem).toBe(true);
    const s3 = createObjectStore(
      loadEnv({
        ...base,
        NODE_ENV: 'test',
        ASSET_STORE_DRIVER: 's3',
        ASSET_S3_ENDPOINT: 'http://localhost:9100',
        ASSET_S3_BUCKET: 'tendr-assets',
        ASSET_S3_ACCESS_KEY_ID: 'minio',
        ASSET_S3_SECRET_ACCESS_KEY: 'minio-secret',
        ASSET_S3_FORCE_PATH_STYLE: 'true',
      }),
    );
    expect('objects' in s3).toBe(false);
  });
});
