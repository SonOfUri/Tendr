'use client';

import { useEffect, useState } from 'react';
import { qrDataUrl } from '@/lib/recovery-kit';

/** A QR code drawn in the browser (no network request). */
export function QrImage({
  value,
  label,
  size = 180,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void qrDataUrl(value).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
      setSrc(null);
    };
  }, [value]);
  if (!src) return <div className="qr" style={{ width: size, height: size }} aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element -- a local data: URL, nothing to optimize
  return <img className="qr" src={src} alt={label} width={size} height={size} />;
}
