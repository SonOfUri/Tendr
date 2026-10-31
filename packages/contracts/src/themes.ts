import { z } from 'zod';
import {
  containsAddressLike,
  containsAddressLikeInMarkdown,
  containsSendInstruction,
  findButtonWordsProblem,
  findCountdownLabelProblem,
} from './theme-text.js';

export const THEME_SCHEMA_VERSION = 1;
export const THEME_MAX_PER_MERCHANT = 20;
export const THEME_ASSET_MAX_PER_MERCHANT = 200;
export const THEME_BLOCKS_MAX = 40;
export const THEME_BLOCK_TEXT_MAX = 5_000;
export const THEME_CSS_MAX_BYTES = 50 * 1024;
export const THEME_HTML_MAX_BYTES = 20 * 1024;
export const LINE_ITEMS_MAX = 50;

const TEXT_PROBLEM = "Text can't contain wallet addresses or payment instructions";

export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');

export const ThemePaletteSchema = z.strictObject({
  accent: HexColorSchema,
  background: HexColorSchema,
  surface: HexColorSchema,
  text: HexColorSchema,
});
export type ThemePalette = z.infer<typeof ThemePaletteSchema>;

export const CURATED_FONTS = {
  inter: { family: 'Inter', category: 'sans', fontsource: '@fontsource/inter' },
  'dm-sans': { family: 'DM Sans', category: 'sans', fontsource: '@fontsource/dm-sans' },
  manrope: { family: 'Manrope', category: 'sans', fontsource: '@fontsource/manrope' },
  'plus-jakarta-sans': {
    family: 'Plus Jakarta Sans',
    category: 'sans',
    fontsource: '@fontsource/plus-jakarta-sans',
  },
  'space-grotesk': {
    family: 'Space Grotesk',
    category: 'sans',
    fontsource: '@fontsource/space-grotesk',
  },
  outfit: { family: 'Outfit', category: 'sans', fontsource: '@fontsource/outfit' },
  sora: { family: 'Sora', category: 'sans', fontsource: '@fontsource/sora' },
  'instrument-sans': {
    family: 'Instrument Sans',
    category: 'sans',
    fontsource: '@fontsource/instrument-sans',
  },
  'bricolage-grotesque': {
    family: 'Bricolage Grotesque',
    category: 'display',
    fontsource: '@fontsource/bricolage-grotesque',
  },
  'playfair-display': {
    family: 'Playfair Display',
    category: 'serif',
    fontsource: '@fontsource/playfair-display',
  },
  'cormorant-garamond': {
    family: 'Cormorant Garamond',
    category: 'serif',
    fontsource: '@fontsource/cormorant-garamond',
  },
  lora: { family: 'Lora', category: 'serif', fontsource: '@fontsource/lora' },
  fraunces: { family: 'Fraunces', category: 'serif', fontsource: '@fontsource/fraunces' },
  'dm-serif-display': {
    family: 'DM Serif Display',
    category: 'display',
    fontsource: '@fontsource/dm-serif-display',
  },
  'jetbrains-mono': {
    family: 'JetBrains Mono',
    category: 'mono',
    fontsource: '@fontsource/jetbrains-mono',
  },
} as const satisfies Record<
  string,
  { family: string; category: 'sans' | 'serif' | 'display' | 'mono'; fontsource: string }
>;
export type CuratedFontId = keyof typeof CURATED_FONTS;
const CURATED_FONT_IDS = Object.keys(CURATED_FONTS) as [CuratedFontId, ...CuratedFontId[]];

const AssetIdSchema = z.string().min(1).max(64);

export const ThemeFontSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('curated'), id: z.enum(CURATED_FONT_IDS) }),
  z.strictObject({ kind: z.literal('asset'), asset_id: AssetIdSchema }),
]);
export type ThemeFont = z.infer<typeof ThemeFontSchema>;

const HttpsUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https:\/\//i.test(u), 'must be an https:// URL');

const LanguageSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'must be a BCP-47 tag');

export const ThemeSettingsSchema = z
  .strictObject({
    display_name: z.string().trim().min(1).max(80),
    logo_asset_id: AssetIdSchema.optional(),
    mode: z.enum(['light', 'dark', 'auto']),
    palettes: z.strictObject({
      light: ThemePaletteSchema.optional(),
      dark: ThemePaletteSchema.optional(),
    }),
    font: ThemeFontSchema,
    corner: z.enum(['square', 'soft', 'round', 'pill']),
    button_label: z.string().trim().min(1).max(40).optional(),
    success_message: z.string().max(500).optional(),
    support_url: HttpsUrlSchema.optional(),
    terms_url: HttpsUrlSchema.optional(),
    celebration: z.enum(['none', 'confetti', 'pulse']),
    language: LanguageSchema.optional(),
    background_image_asset_id: AssetIdSchema.optional(),
  })
  .superRefine((s, ctx) => {
    const need = s.mode === 'auto' ? (['light', 'dark'] as const) : ([s.mode] as const);
    for (const m of need) {
      if (!s.palettes[m]) {
        ctx.addIssue({
          code: 'custom',
          path: ['palettes', m],
          message: `A ${m} palette is required for ${s.mode} mode`,
        });
      }
    }
    if (s.button_label !== undefined) {
      const p = findButtonWordsProblem(s.button_label);
      if (p) ctx.addIssue({ code: 'custom', path: ['button_label'], message: p });
    }
  });
export type ThemeSettings = z.infer<typeof ThemeSettingsSchema>;

// ---------------------------------------------------------------- blocks

const BlockId = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, 'must be 1-32 lower-case letters, digits or hyphens');
const base = { id: BlockId, hidden: z.boolean().optional() };

const MarkdownSchema = z
  .string()
  .max(THEME_BLOCK_TEXT_MAX)
  .superRefine((md, ctx) => {
    if (/<[a-zA-Z/!?]/.test(md)) {
      ctx.addIssue({ code: 'custom', message: "Text can't contain HTML" });
    }
    if (/!\[/.test(md)) {
      ctx.addIssue({ code: 'custom', message: "Text can't contain inline images" });
    }
    for (const m of md.matchAll(/\]\(\s*([^)\s]*)/g)) {
      if (!/^https:\/\//i.test(m[1] ?? '')) {
        ctx.addIssue({ code: 'custom', message: 'Links in text must start with https://' });
        break;
      }
    }
    if (/^\s{0,3}\[[^\]]+\]:/m.test(md)) {
      ctx.addIssue({ code: 'custom', message: 'Reference-style links are not supported' });
    }
  });

const Short = z.string().min(1).max(200);

const leafBlocks = [
  z.strictObject({
    ...base,
    type: z.literal('header'),
    show_logo: z.boolean(),
    show_name: z.boolean(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('heading'),
    text: Short,
    level: z.union([z.literal(2), z.literal(3)]),
  }),
  z.strictObject({ ...base, type: z.literal('rich_text'), markdown: MarkdownSchema }),
  z.strictObject({
    ...base,
    type: z.literal('image'),
    asset_id: AssetIdSchema,
    alt: z.string().max(200),
    link_url: HttpsUrlSchema.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('banner'),
    text: z.string().max(500).optional(),
    asset_id: AssetIdSchema.optional(),
    background: HexColorSchema.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('video'),
    provider: z.enum(['youtube', 'vimeo']),
    video_id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  }),
  z.strictObject({ ...base, type: z.literal('divider') }),
  z.strictObject({ ...base, type: z.literal('spacer'), size: z.enum(['sm', 'md', 'lg']) }),
  z.strictObject({ ...base, type: z.literal('order_summary') }),
  z.strictObject({
    ...base,
    type: z.literal('trust_badges'),
    badges: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('tendr'),
            id: z.enum(['non-custodial', 'refund-promise', 'secure-checkout']),
          }),
          z.strictObject({
            kind: z.literal('asset'),
            asset_id: AssetIdSchema,
            alt: z.string().max(200),
          }),
        ]),
      )
      .max(8),
  }),
  z.strictObject({
    ...base,
    type: z.literal('reviews'),
    items: z
      .array(
        z.strictObject({
          quote: z.string().min(1).max(500),
          author: z.string().min(1).max(80),
          rating: z.number().int().min(1).max(5).optional(),
        }),
      )
      .max(10),
  }),
  z.strictObject({
    ...base,
    type: z.literal('faq'),
    items: z
      .array(z.strictObject({ q: z.string().min(1).max(200), a: z.string().min(1).max(1000) }))
      .max(20),
  }),
  z.strictObject({
    ...base,
    type: z.literal('countdown'),
    label: z.string().min(1).max(80),
    ends_at: z.string().datetime({ offset: true }),
  }),
  z.strictObject({ ...base, type: z.literal('delivery_note'), text: z.string().min(1).max(500) }),
  z.strictObject({
    ...base,
    type: z.literal('social_links'),
    links: z
      .array(
        z.strictObject({
          network: z.enum([
            'instagram',
            'x',
            'tiktok',
            'facebook',
            'whatsapp',
            'youtube',
            'website',
          ]),
          url: HttpsUrlSchema,
        }),
      )
      .max(10),
  }),
  z.strictObject({
    ...base,
    type: z.literal('footer_links'),
    links: z
      .array(z.strictObject({ label: z.string().min(1).max(80), url: HttpsUrlSchema }))
      .max(10),
  }),
  z.strictObject({
    ...base,
    type: z.literal('custom_html'),
    html: z.string().refine((h) => new TextEncoder().encode(h).length <= THEME_HTML_MAX_BYTES, {
      message: 'HTML block is over 20 KB',
    }),
  }),
] as const;

/** A block that may sit inside `columns` or `section`: never a container or a sealed/success block. */
export const ThemeLeafBlockSchema = z.discriminatedUnion('type', [...leafBlocks]);
export type ThemeLeafBlock = z.infer<typeof ThemeLeafBlockSchema>;

const NestedList = z.array(ThemeLeafBlockSchema).max(THEME_BLOCKS_MAX);

export const ThemeBlockSchema = z.discriminatedUnion('type', [
  ...leafBlocks,
  z.strictObject({
    ...base,
    type: z.literal('columns'),
    columns: z.tuple([NestedList, NestedList]),
  }),
  z.strictObject({
    ...base,
    type: z.literal('section'),
    background: HexColorSchema.optional(),
    background_asset_id: AssetIdSchema.optional(),
    blocks: NestedList,
  }),
  z.strictObject({ ...base, type: z.literal('payment') }),
  z.strictObject({ ...base, type: z.literal('thank_you') }),
  z.strictObject({
    ...base,
    type: z.literal('back_to_store'),
    label: z.string().max(40).optional(),
  }),
]);
export type ThemeBlock = z.infer<typeof ThemeBlockSchema>;

// -------------------------------------------------------------- document

type Walk = (block: ThemeBlock | ThemeLeafBlock, path: (string | number)[], top: boolean) => void;

function walkBlocks(
  list: readonly (ThemeBlock | ThemeLeafBlock)[],
  path: (string | number)[],
  top: boolean,
  fn: Walk,
): void {
  list.forEach((b, i) => {
    const p = [...path, i];
    fn(b, p, top);
    if (b.type === 'columns') {
      b.columns.forEach((col, ci) => walkBlocks(col, [...p, 'columns', ci], false, fn));
    } else if (b.type === 'section') {
      walkBlocks(b.blocks, [...p, 'blocks'], false, fn);
    }
  });
}

function textFields(b: ThemeBlock | ThemeLeafBlock): Array<[string, string]> {
  switch (b.type) {
    case 'heading':
      return [['text', b.text]];
    case 'rich_text':
      return [['markdown', b.markdown]];
    case 'banner':
      return b.text ? [['text', b.text]] : [];
    case 'image':
      return [['alt', b.alt]];
    case 'delivery_note':
      return [['text', b.text]];
    case 'countdown':
      return [['label', b.label]];
    case 'back_to_store':
      return b.label ? [['label', b.label]] : [];
    case 'reviews':
      return b.items.flatMap((it, i): Array<[string, string]> => [
        [`items.${i}.quote`, it.quote],
        [`items.${i}.author`, it.author],
      ]);
    case 'faq':
      return b.items.flatMap((it, i): Array<[string, string]> => [
        [`items.${i}.q`, it.q],
        [`items.${i}.a`, it.a],
      ]);
    case 'footer_links':
      return b.links.map((l, i): [string, string] => [`links.${i}.label`, l.label]);
    case 'trust_badges':
      return b.badges.flatMap((bd, i): Array<[string, string]> =>
        bd.kind === 'asset' ? [[`badges.${i}.alt`, bd.alt]] : [],
      );
    default:
      return [];
  }
}

function countBlocks(list: readonly ThemeBlock[]): number {
  let n = 0;
  walkBlocks(list, [], true, () => {
    n += 1;
  });
  return n;
}

export const ThemeDocumentSchema = z
  .strictObject({
    schema_version: z.literal(THEME_SCHEMA_VERSION),
    settings: ThemeSettingsSchema,
    blocks: z.array(ThemeBlockSchema),
    success_blocks: z.array(ThemeBlockSchema),
    custom_css: z
      .string()
      .refine((c) => new TextEncoder().encode(c).length <= THEME_CSS_MAX_BYTES, {
        message: 'CSS is over 50 KB',
      })
      .optional(),
  })
  .superRefine((doc, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });

    for (const key of ['blocks', 'success_blocks'] as const) {
      if (countBlocks(doc[key]) > THEME_BLOCKS_MAX) {
        issue([key], `A page can have at most ${THEME_BLOCKS_MAX} blocks`);
      }
    }

    const seen = new Set<string>();
    let payments = 0;
    for (const key of ['blocks', 'success_blocks'] as const) {
      walkBlocks(doc[key], [key], true, (b, path, top) => {
        if (seen.has(b.id)) issue([...path, 'id'], `Block id "${b.id}" is used twice`);
        seen.add(b.id);

        if (b.type === 'payment') {
          payments += 1;
          if (key !== 'blocks' || !top) {
            issue(
              path,
              'The payment block must be on the main page, not nested or on the thank-you page',
            );
          }
        }
        if (
          (b.type === 'thank_you' || b.type === 'back_to_store') &&
          (key !== 'success_blocks' || !top)
        ) {
          issue(path, `The ${b.type.replace('_', ' ')} block belongs on the thank-you page only`);
        }

        for (const [field, value] of textFields(b)) {
          const fp = [...path, ...field.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s))];
          const addressLike =
            b.type === 'rich_text' && field === 'markdown'
              ? containsAddressLikeInMarkdown(value)
              : containsAddressLike(value);
          if (addressLike || containsSendInstruction(value)) {
            issue(fp, TEXT_PROBLEM);
          }
          if (b.type === 'countdown' && field === 'label') {
            const p = findCountdownLabelProblem(value);
            if (p) issue(fp, p);
          }
        }
      });
    }
    if (payments !== 1) {
      issue(['blocks'], 'The page needs exactly one payment block');
    }

    const s = doc.settings;
    const settingText: Array<[string, string | undefined]> = [
      ['display_name', s.display_name],
      ['success_message', s.success_message],
      ['button_label', s.button_label],
    ];
    for (const [k, v] of settingText) {
      if (v !== undefined && (containsAddressLike(v) || containsSendInstruction(v))) {
        issue(['settings', k], TEXT_PROBLEM);
      }
    }
  });
export type ThemeDocument = z.infer<typeof ThemeDocumentSchema>;

// ------------------------------------------------------------ API objects

export const ThemePresetIdSchema = z.enum(['blank', 'fashion', 'gaming', 'nonprofit', 'minimal']);

export const ThemeObjectSchema = z.object({
  id: z.string(),
  object: z.literal('theme'),
  name: z.string(),
  is_default: z.boolean(),
  version: z.number().int(),
  status: z.enum(['draft', 'published']),
  draft: ThemeDocumentSchema,
  published: ThemeDocumentSchema.nullable(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  used_by_links: z.number().int(),
});
export type ThemeObject = z.infer<typeof ThemeObjectSchema>;

export const ThemeAssetObjectSchema = z.object({
  id: z.string(),
  object: z.literal('theme_asset'),
  kind: z.enum(['logo', 'image', 'font']),
  url: z.string(),
  mime: z.string(),
  size_bytes: z.number().int(),
  checksum: z.string(),
  created_at: z.string(),
});
export type ThemeAssetObject = z.infer<typeof ThemeAssetObjectSchema>;

const ThemeName = z.string().trim().min(1).max(80);

export const ThemeCreateSchema = z.strictObject({
  name: ThemeName,
  from: z.union([
    z.strictObject({ preset: ThemePresetIdSchema }),
    z.strictObject({ theme_id: z.string().min(1) }),
    z.literal('blank'),
  ]),
});
export type ThemeCreate = z.infer<typeof ThemeCreateSchema>;

export const ThemeUpdateSchema = z.strictObject({
  name: ThemeName.optional(),
  draft: ThemeDocumentSchema.optional(),
});
export type ThemeUpdate = z.infer<typeof ThemeUpdateSchema>;

export const ThemeValidateSchema = z.object({ document: ThemeDocumentSchema });
export type ThemeValidate = z.infer<typeof ThemeValidateSchema>;

export const ThemeFromWebsiteSchema = z.object({
  url: HttpsUrlSchema,
  name: ThemeName.optional(),
});
export type ThemeFromWebsite = z.infer<typeof ThemeFromWebsiteSchema>;

export const ThemeFromStoreSchema = z.object({
  connection_id: z.string().min(1),
  name: ThemeName.optional(),
});
export type ThemeFromStore = z.infer<typeof ThemeFromStoreSchema>;

export const ThemePreviewSchema = z.object({
  sample: z.enum(['checkout', 'link']),
  scheme: z.enum(['light', 'dark']),
  viewport: z.enum(['phone', 'desktop']),
});
export type ThemePreview = z.infer<typeof ThemePreviewSchema>;

export const LineItemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(10_000),
  unit_amount: z.string().regex(/^\d+(?:\.\d+)?$/, 'must be a decimal string like "25.10"'),
  image_url: HttpsUrlSchema.optional(),
  description: z.string().max(500).optional(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const ConnectionBrandSchema = z.object({
  site_name: z.string().max(120).optional(),
  logo_url: HttpsUrlSchema.optional(),
  icon_url: HttpsUrlSchema.optional(),
  palette: z.array(HexColorSchema).max(12),
});
export type ConnectionBrand = z.infer<typeof ConnectionBrandSchema>;

export const ShopperThemeSchema = z.object({
  id: z.string().nullable(),
  version: z.number().int(),
  document: ThemeDocumentSchema,
  rendered: z.record(z.string(), z.string()),
  assets: z.record(
    z.string(),
    z.object({ url: z.string(), kind: z.enum(['logo', 'image', 'font']), mime: z.string() }),
  ),
  css: z.string().nullable(),
  payee: z.string(),
  trading_as: z.string().nullable(),
});
export type ShopperTheme = z.infer<typeof ShopperThemeSchema>;
