'use client';

import { useMemo, useState } from 'react';
import { demoCodeSnippet, type DemoDefinition } from '@/lib/demo';

type Props = {
  demo: DemoDefinition;
};

function highlight(code: string) {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Lift strings out first so later passes never mangle span attributes.
  const strings: string[] = [];
  let out = escaped.replace(/"[^"]*"|'[^']*'/g, (match) => {
    const i = strings.length;
    strings.push(match);
    return `\u0000S${i}\u0000`;
  });

  out = out
    .replace(
      /\b(import|from|function|const|return|console)\b/g,
      '<span class="tok-kw">$1</span>',
    )
    .replace(
      /\b(TendrCheckout|useCheckoutSession|App)\b/g,
      '<span class="tok-fn">$1</span>',
    )
    .replace(
      /\b(amount|currency|description|mode|onSuccess|onClick|open|log|session)\b/g,
      '<span class="tok-prop">$1</span>',
    );

  return out.replace(/\u0000S(\d+)\u0000/g, (_, index) => {
    return `<span class="tok-str">${strings[Number(index)]}</span>`;
  });
}

export function CodePanel({ demo }: Props) {
  const [copied, setCopied] = useState(false);
  const snippet = useMemo(() => demoCodeSnippet(demo), [demo]);
  const lines = useMemo(() => {
    const highlighted = highlight(snippet);
    return highlighted.split('\n');
  }, [snippet]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="demo-code-panel">
      <div className="demo-code-toolbar">
        <button type="button" onClick={copy} aria-label={copied ? 'Copied' : 'Copy code'}>
          {copied ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M5 15V5a2 2 0 0 1 2-2h10"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>
      <pre className="demo-code-pre">
        <code>
          {lines.map((line, i) => (
            <span className="demo-code-line" key={`line-${i + 1}`}>
              <span className="demo-code-lineno" aria-hidden>
                {i + 1}
              </span>
              <span
                className="demo-code-text"
                dangerouslySetInnerHTML={{ __html: line.length ? line : '&nbsp;' }}
              />
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
