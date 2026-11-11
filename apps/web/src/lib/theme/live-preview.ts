import type { ShopperTheme, ThemeDocument, ThemePreview } from '@tendr/contracts';
import type { PreviewRead } from '@/app/preview/theme/[token]/ThemePreview';
import type { ThemeAssetObject } from '@/lib/themes';

/** Fixed USD sample cart (matches the API's non-NGN checkout sample). */
export function livePreviewSample(): PreviewRead['sample'] {
  return {
    kind: 'checkout',
    amount: '49.00',
    amount_currency: 'USD',
    line_items: [
      {
        name: 'Linen shirt',
        quantity: 1,
        unit_amount: '29.00',
        description: 'Sample item',
        image_url: null,
      },
      {
        name: 'Canvas tote',
        quantity: 1,
        unit_amount: '20.00',
        description: 'Sample item',
        image_url: null,
      },
    ],
  };
}

/**
 * Build a shopper theme from the editor's in-memory draft so the right-hand preview
 * can update without minting a preview token.
 */
export function shopperThemeFromDraft(input: {
  themeId: string;
  version: number;
  document: ThemeDocument;
  css: string | null;
  assets: ThemeAssetObject[];
  merchantName: string;
}): ShopperTheme {
  const { themeId, version, document, css, assets, merchantName } = input;
  const display = document.settings.display_name?.trim() || merchantName;
  const assetMap: ShopperTheme['assets'] = {};
  for (const a of assets) {
    assetMap[a.id] = { url: a.url, kind: a.kind, mime: a.mime };
  }
  return {
    id: themeId,
    version,
    document,
    rendered: {},
    assets: assetMap,
    css: css && css.trim() ? css : null,
    payee: display,
    trading_as: null,
  };
}

/** Full preview payload for `PreviewBody` from the live editor state. */
export function livePreviewRead(input: {
  themeId: string;
  version: number;
  document: ThemeDocument;
  css: string | null;
  assets: ThemeAssetObject[];
  merchantName: string;
  scheme: ThemePreview['scheme'];
  viewport?: ThemePreview['viewport'];
}): PreviewRead {
  return {
    preview: true,
    opts: {
      sample: 'checkout',
      scheme: input.scheme,
      viewport: input.viewport ?? 'desktop',
    },
    theme: shopperThemeFromDraft(input),
    sample: livePreviewSample(),
  };
}
