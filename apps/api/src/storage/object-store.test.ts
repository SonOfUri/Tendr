import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import {
  createObjectStore,
  createS3Client,
  memoryObjectStore,
  s3ObjectStore,
} from './object-store.js';

describe('object store', () => {
  it('reads private bucket assets and preserves their content type and ETag', async () => {
    let sent: unknown;
    const client = {
      send: async (command: unknown) => {
        sent = command;
        return {
          ContentType: 'image/png',
          ContentLength: 3,
          ETag: '"abc"',
          Body: {
            transformToWebStream: () =>
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Buffer.from('png'));
                  controller.close();
                },
              }),
          },
        };
      },
    } as unknown as S3Client;
    const asset = await s3ObjectStore(client, 'private-assets').get!('assets/mer_1/a.png');
    expect(sent).toBeInstanceOf(GetObjectCommand);
    expect((sent as GetObjectCommand).input).toEqual({
      Bucket: 'private-assets',
      Key: 'assets/mer_1/a.png',
    });
    expect(asset).toEqual({ body: Buffer.from('png'), contentType: 'image/png', etag: '"abc"' });
  });

  it.each([undefined, 1, 5 * 1024 * 1024])(
    'cancels oversized reads even with absent or inaccurate ContentLength (%s)',
    async (contentLength) => {
      let cancelled = false;
      let reads = 0;
      const client = {
        send: async () => ({
          ContentType: 'image/png',
          ContentLength: contentLength,
          Body: {
            transformToWebStream: () =>
              new ReadableStream({
                pull(controller) {
                  reads++;
                  controller.enqueue(Buffer.alloc(1024 * 1024));
                },
                cancel() {
                  cancelled = true;
                },
              }),
          },
        }),
      } as unknown as S3Client;
      await expect(s3ObjectStore(client, 'private-assets').get!('assets/m/a.png')).rejects.toThrow(
        'size limit',
      );
      expect(cancelled).toBe(true);
      expect(reads).toBeLessThanOrEqual(6);
    },
  );

  it('maps missing objects to null but preserves permission failures', async () => {
    const missing = {
      send: async () => {
        throw { name: 'NoSuchKey' };
      },
    } as unknown as S3Client;
    expect(await s3ObjectStore(missing, 'private-assets').get!('assets/m/a.png')).toBeNull();
    const forbidden = {
      send: async () => {
        throw new Error('AccessDenied');
      },
    } as unknown as S3Client;
    await expect(s3ObjectStore(forbidden, 'private-assets').get!('assets/m/a.png')).rejects.toThrow(
      'AccessDenied',
    );
  });
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

  it('talks to GCS interop without CRC checksum headers', async () => {
    const e = loadEnv({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://localhost:6380',
      NODE_ENV: 'test',
      ASSET_STORE_DRIVER: 's3',
      ASSET_S3_ENDPOINT: 'https://storage.googleapis.com',
      ASSET_S3_REGION: 'auto',
      ASSET_S3_BUCKET: 'tendr-assets-dev',
      ASSET_S3_ACCESS_KEY_ID: 'GOOGTEST',
      ASSET_S3_SECRET_ACCESS_KEY: 'secret',
      ASSET_S3_FORCE_PATH_STYLE: 'true',
    });
    let captured: { method: string; url: string; headers: Record<string, string> } | undefined;
    const requestHandler = {
      async handle(req: {
        method: string;
        protocol: string;
        hostname: string;
        path: string;
        headers: Record<string, string>;
      }) {
        captured = {
          method: req.method,
          url: `${req.protocol}//${req.hostname}${req.path}`,
          headers: req.headers,
        };
        return { response: { statusCode: 200, headers: {}, body: undefined } };
      },
      updateHttpClientConfig() {},
      httpHandlerConfigs: () => ({}),
    };
    const client = createS3Client(e, { requestHandler: requestHandler as never });
    expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
    expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
    await s3ObjectStore(client, 'tendr-assets-dev').put(
      'assets/m/a.png',
      Buffer.from('x'),
      'image/png',
    );
    expect(captured?.method).toBe('PUT');
    expect(captured?.url).toBe('https://storage.googleapis.com/tendr-assets-dev/assets/m/a.png');
    expect(captured?.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const checksumHeaders = Object.keys(captured?.headers ?? {}).filter((h) =>
      h.toLowerCase().startsWith('x-amz-checksum'),
    );
    expect(checksumHeaders).toEqual([]);
  });
});
