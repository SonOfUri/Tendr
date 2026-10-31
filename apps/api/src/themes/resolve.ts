// Which theme a shopper sees, ready to render (spec §2.3):
//   1. the theme the session or link names: its published version, or in test mode its draft;
//   2. otherwise the store's default (published) theme;
//   3. otherwise the Tendr default look.
// A step whose stored document no longer parses (corrupt JSON, an older shape) is logged and
// skipped: a theme never stops a shopper paying.
import {
  namesMatch,
  ThemeDocumentSchema,
  TENDR_DEFAULT_THEME,
  type ShopperTheme,
  type ThemeDocument,
} from '@tendr/contracts';
import type { ScopedDb } from '../db/scoped.js';
import { log } from '../lib/logger.js';
import { renderMarkdownSubset } from './markdown.js';
import { eachBlock, referencedAssetIds } from './validate.js';

export type ShopperThemeInput = {
  merchantId: string;
  /** The account's name: the payee line. */
  merchantName: string;
  /** The theme the session or link names; null for none. */
  themeId: string | null;
  livemode: boolean;
  kind: 'checkout' | 'link';
  link?: { title: string; description: string | null };
};

type Candidate = { id: string; version: number; document: unknown; css: string | null };

const SELECT = {
  id: true,
  version: true,
  draft: true,
  draftCss: true,
  published: true,
  publishedCss: true,
} as const;

/** The named theme's version to show: published, or the draft in test mode. */
async function named(db: ScopedDb, themeId: string, livemode: boolean): Promise<Candidate | null> {
  const row = await db.checkoutTheme.findFirst({ where: { id: themeId }, select: SELECT });
  if (!row) return null;
  if (!livemode) {
    return { id: row.id, version: row.version, document: row.draft, css: row.draftCss };
  }
  if (row.published === null) return null;
  return { id: row.id, version: row.version, document: row.published, css: row.publishedCss };
}

async function storeDefault(db: ScopedDb): Promise<Candidate | null> {
  const row = await db.checkoutTheme.findFirst({
    where: { isDefault: true, status: 'published' },
    select: SELECT,
  });
  if (!row || row.published === null) return null;
  return { id: row.id, version: row.version, document: row.published, css: row.publishedCss };
}

function parsed(c: Candidate | null, input: ShopperThemeInput, step: string) {
  if (!c) return null;
  const r = ThemeDocumentSchema.safeParse(c.document);
  if (r.success) return { ...c, document: r.data };
  log('warn', 'stored theme does not parse; falling back', {
    merchantId: input.merchantId,
    themeId: c.id,
    step,
    issues: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
  });
  return null;
}

/** Each `rich_text` block's markdown rendered to safe HTML, by block id. */
function renderedText(doc: ThemeDocument): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['blocks', 'success_blocks'] as const) {
    eachBlock(doc[key], [key], (b) => {
      if (b.type === 'rich_text') out[b.id] = renderMarkdownSubset(b.markdown);
    });
  }
  return out;
}

async function assetMap(db: ScopedDb, doc: ThemeDocument): Promise<ShopperTheme['assets']> {
  const ids = referencedAssetIds(doc);
  if (ids.length === 0) return {};
  const rows = await db.themeAsset.findMany({
    where: { id: { in: ids } },
    select: { id: true, url: true, kind: true, mime: true },
  });
  return Object.fromEntries(rows.map((a) => [a.id, { url: a.url, kind: a.kind, mime: a.mime }]));
}

/** The theme the shopper's page renders: never throws for a bad theme, falls back instead. */
export async function resolveShopperTheme(
  db: ScopedDb,
  input: ShopperThemeInput,
): Promise<ShopperTheme> {
  const chosen =
    (input.themeId
      ? parsed(await named(db, input.themeId, input.livemode), input, 'named')
      : null) ?? parsed(await storeDefault(db), input, 'default');

  const document = chosen?.document ?? TENDR_DEFAULT_THEME(input.merchantName);
  const displayName = document.settings.display_name;
  // The merchant's CSS source is not sent: shoppers get only the scoped, checked `css`.
  const shown: ThemeDocument = { ...document };
  delete shown.custom_css;
  return {
    id: chosen?.id ?? null,
    version: chosen?.version ?? 0,
    document: shown,
    rendered: renderedText(document),
    assets: await assetMap(db, document),
    css: chosen?.css ?? null,
    payee: input.merchantName,
    trading_as: namesMatch(displayName, input.merchantName) ? null : displayName,
  };
}
