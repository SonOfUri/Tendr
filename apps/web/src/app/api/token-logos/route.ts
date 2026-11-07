import { NextResponse } from 'next/server';
import {
  dextoolsLogoUrl,
  dextoolsTarget,
  nearFtAccount,
  nearTokenIcon,
  publicImageUrl,
} from '@/lib/token-logo';

const ENDPOINT = 'https://public-api.dextools.io/trial/v2/token';
const OK_MS = 24 * 60 * 60 * 1000;
const MISS_MS = 6 * 60 * 60 * 1000;
const MAX_TOKENS = 40;

type CacheEntry = { url: string | null; exp: number };
const cache = new Map<string, CacheEntry>();

let paceAt = 0;

/** Space calls out so opening one token grid does not burst the trial quota. */
function pace(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, paceAt);
  paceAt = start + 100;
  const wait = start - now;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

/** NEAR tokens store their artwork in `ft_metadata.icon`. Dextools does not have most of them. */
async function nearMetadataIcon(account: string): Promise<string | null> {
  try {
    const res = await fetch('https://rpc.mainnet.near.org', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'logo',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: account,
          method_name: 'ft_metadata',
          args_base64: 'e30=',
        },
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { result?: number[] } };
    const bytes = body.result?.result;
    if (!Array.isArray(bytes)) return null;
    const text = Buffer.from(bytes).toString('utf8');
    const meta = JSON.parse(text) as { icon?: unknown };
    const ready = nearTokenIcon(meta.icon);
    if (ready) return ready;
    if (typeof meta.icon === 'string') {
      const remote = publicImageUrl(meta.icon);
      if (remote) return await remoteIcon(remote);
    }
    return null;
  } catch {
    return null;
  }
}

async function remoteIcon(href: string): Promise<string | null> {
  try {
    const res = await fetch(href, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok || !publicImageUrl(res.url)) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(type)) {
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 200_000) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

async function lookup(asset: string): Promise<string | null> {
  const hit = cache.get(asset);
  if (hit && hit.exp > Date.now()) return hit.url;
  const near = nearFtAccount(asset);
  if (near) {
    const icon = await nearMetadataIcon(near);
    if (icon) {
      cache.set(asset, { url: icon, exp: Date.now() + OK_MS });
      return icon;
    }
  }
  const target = dextoolsTarget(asset);
  if (!target) {
    cache.set(asset, { url: null, exp: Date.now() + MISS_MS });
    return null;
  }
  const key = process.env.DEXTOOLS_API_KEY;
  if (!key) return null;

  await pace();
  try {
    const res = await fetch(
      `${ENDPOINT}/${target.chain}/${encodeURIComponent(target.address)}`,
      { headers: { 'X-API-KEY': key, accept: 'application/json' }, cache: 'no-store' },
    );
    if (res.status === 429 || res.status >= 500) return null;
    const body = (await res.json()) as { data?: { logo?: unknown } };
    const url = dextoolsLogoUrl(body.data?.logo);
    cache.set(asset, { url, exp: Date.now() + (url ? OK_MS : MISS_MS) });
    return url;
  } catch {
    return null;
  }
}

async function mapPool(assets: string[]): Promise<Record<string, string | null>> {
  const logos: Record<string, string | null> = {};
  let index = 0;
  async function worker() {
    while (index < assets.length) {
      const asset = assets[index]!;
      index += 1;
      logos[asset] = await lookup(asset);
    }
  }
  const workers = Math.min(6, assets.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return logos;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ logos: {} }, { status: 400 });
  }
  const tokens = (body as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) return NextResponse.json({ logos: {} }, { status: 400 });
  const assets = [
    ...new Set(
      tokens.filter((token): token is string => typeof token === 'string' && token.length > 0 && token.length <= 180),
    ),
  ].slice(0, MAX_TOKENS);
  const logos = await mapPool(assets);
  return NextResponse.json(
    { logos },
    { headers: { 'cache-control': 'private, max-age=300' } },
  );
}
