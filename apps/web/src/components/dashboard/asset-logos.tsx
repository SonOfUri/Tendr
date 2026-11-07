'use client';

import { useState, type ReactNode } from 'react';
import { CHAINS } from '@/lib/assets';
import { chainLogo } from '@/lib/chain-logos';

/** Dashboard chain ids → the ids `chainLogo` already knows (Trust Wallet / Llama). */
const CHAIN_ID: Record<string, string> = {
  near: 'near',
  eth: 'eth',
  ethereum: 'eth',
  base: 'base',
  arbitrum: 'arb',
  arb: 'arb',
  polygon: 'pol',
  pol: 'pol',
  matic: 'pol',
  bsc: 'bsc',
  optimism: 'op',
  op: 'op',
  avalanche: 'avax',
  avax: 'avax',
  sol: 'sol',
  solana: 'sol',
  tron: 'tron',
  btc: 'btc',
  bitcoin: 'btc',
};

/** Native symbols share the chain mark instead of a separate token file. */
const TOKEN_AS_CHAIN: Record<string, string> = {
  NEAR: 'near',
  WNEAR: 'near',
  ETH: 'eth',
  WETH: 'eth',
  BTC: 'btc',
  WBTC: 'btc',
  SOL: 'sol',
  BNB: 'bsc',
  POL: 'pol',
  MATIC: 'pol',
  AVAX: 'avax',
  TRX: 'tron',
  OP: 'op',
};

const TOKEN_ICON = 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color';

function tokenSrc(symbol: string): string {
  const key = symbol.trim().toUpperCase().replace(/^\$/, '');
  const chain = TOKEN_AS_CHAIN[key];
  if (chain) return chainLogo(chain).logoSrc;
  const file = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return file ? `${TOKEN_ICON}/${file}.png` : '';
}

/** A small chain mark for dropdowns. Trust Wallet (via jsDelivr), then Llama, then a letter. */
export function ChainLogo({ chain, size = 18 }: { chain: string; size?: number }) {
  const id = chain.toLowerCase();
  const src = chainLogo(CHAIN_ID[id] ?? id).logoSrc;
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <RealLogo src={src} letter={chain.slice(0, 1).toUpperCase() || '?'} />
    </span>
  );
}

const logoCache = new Map<string, string | null>();
const logoWaiters = new Map<string, Array<(url: string | null) => void>>();
let logoQueue: string[] = [];
let logoFlush: ReturnType<typeof setTimeout> | null = null;

/** One batched call per grid open. The key never leaves the server route. */
function requestTokenLogo(assetId: string): Promise<string | null> {
  if (logoCache.has(assetId)) return Promise.resolve(logoCache.get(assetId) ?? null);
  return new Promise((resolve) => {
    const waiting = logoWaiters.get(assetId) ?? [];
    waiting.push(resolve);
    logoWaiters.set(assetId, waiting);
    if (!logoQueue.includes(assetId)) logoQueue.push(assetId);
    logoFlush ??= setTimeout(() => void flushTokenLogos(), 50);
  });
}

async function flushTokenLogos() {
  logoFlush = null;
  const batch = logoQueue.splice(0, 40);
  if (logoQueue.length > 0) logoFlush = setTimeout(() => void flushTokenLogos(), 50);
  let logos: Record<string, string | null> = {};
  try {
    const res = await fetch('/api/token-logos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: batch }),
    });
    if (res.ok) {
      const data = (await res.json()) as { logos?: Record<string, string | null> };
      logos = data.logos ?? {};
    }
  } catch {
    logos = {};
  }
  for (const asset of batch) {
    const url = typeof logos[asset] === 'string' ? logos[asset] : null;
    logoCache.set(asset, url);
    for (const waiter of logoWaiters.get(asset) ?? []) waiter(url);
    logoWaiters.delete(asset);
  }
}

/**
 * A small token mark. Known symbols use the icon CDN. When that image is missing and the
 * asset id encodes a contract, Dextools fills the logo. Anything still missing gets an initial.
 */
export function TokenLogo({
  symbol,
  assetId,
  size = 18,
}: {
  symbol: string;
  assetId?: string;
  size?: number;
}) {
  const key = symbol.trim().toUpperCase().replace(/^\$/, '') || '?';
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <RealLogo src={tokenSrc(key)} letter={key.slice(0, 1)} assetId={assetId} />
    </span>
  );
}

export function chainSelectOptions(): { value: string; label: string; icon: ReactNode }[] {
  return CHAINS.map((chain) => ({
    value: chain.id,
    label: chain.label,
    icon: <ChainLogo chain={chain.id} />,
  }));
}

/** Options for an asset id list; known symbols get a token mark. */
export function tokenSelectOptions(
  assetIds: Iterable<string>,
  resolve: (id: string) => { known: boolean; symbol: string },
): { value: string; label: string; icon: ReactNode }[] {
  return [...new Set(assetIds)].map((id) => {
    const known = resolve(id);
    return {
      value: id,
      label: known.known ? known.symbol : id,
      icon: <TokenLogo symbol={known.known ? known.symbol : id} assetId={id} />,
    };
  });
}

function RealLogo({ src, letter, assetId }: { src: string; letter: string; assetId?: string }) {
  const identity = `${src}\0${assetId ?? ''}`;
  const [seen, setSeen] = useState(identity);
  const [current, setCurrent] = useState(src);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(false);
  if (seen !== identity) {
    setSeen(identity);
    setCurrent(src);
    setFailed(false);
    setAsked(false);
  }

  function onError() {
    if (!asked && assetId) {
      setAsked(true);
      void requestTokenLogo(assetId).then((url) => {
        if (url) setCurrent(url);
        else setFailed(true);
      });
      return;
    }
    setFailed(true);
  }

  if (!current || failed) return <LetterMark letter={letter} fill="#3a3a3a" />;
  return <img src={current} alt="" draggable={false} onError={onError} />;
}

function LetterMark({ letter, fill }: { letter: string; fill: string }) {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      <circle cx="12" cy="12" r="12" fill={fill} />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="11"
        fontFamily="system-ui, sans-serif"
        fontWeight="700"
        fill="#fff"
      >
        {letter}
      </text>
    </svg>
  );
}
