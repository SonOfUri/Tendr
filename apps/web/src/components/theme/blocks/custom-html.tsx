// The custom HTML block. The API sanitised `html` on save (allowlist, no forms or scripts, Tendr
// asset images only, https links), so it is rendered as stored, inside the block's contained box.
import type { ThemeLeafBlock } from '@tendr/contracts';
import type { ReactNode } from 'react';

export function customHtml(block: Extract<ThemeLeafBlock, { type: 'custom_html' }>): ReactNode {
  if (!block.html.trim()) return null;
  return <div className="tdr-custom-html" dangerouslySetInnerHTML={{ __html: block.html }} />;
}
