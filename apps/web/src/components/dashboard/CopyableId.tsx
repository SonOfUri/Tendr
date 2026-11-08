'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '@/lib/share-link';
import { toast } from '@/components/toast';

/** Middle-ellipsis for long account ids / addresses (`0xa5cd…983c`). */
export function shortId(id: string, head = 6, tail = 4): string {
  const t = id.trim();
  if (t.length <= head + tail + 1) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

export function CopyableId({
  value,
  label = 'Copy to clipboard',
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={`dash-copyable-id ${className}`.trim()}>
      <span className="dash-copyable-id-full dash-mono" title={value}>
        {value}
      </span>
      <span className="dash-copyable-id-short dash-mono" title={value}>
        {shortId(value)}
      </span>
      <button
        type="button"
        className="dash-copyable-id-btn"
        aria-label={copied ? 'Copied' : label}
        title={copied ? 'Copied' : label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void copyToClipboard(value).then((ok) => {
            if (!ok) {
              toast.error('Could not copy. Select the text and copy it manually.');
              return;
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={2} />}
      </button>
    </span>
  );
}
