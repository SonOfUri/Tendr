import {
  findContrastProblems,
  ThemeDocumentSchema,
  type ThemeBlock,
  type ThemeDocument,
  type ThemeLeafBlock,
} from '@tendr/contracts';
import { scopeThemeCss } from './css.js';
import { sanitizeThemeHtml } from './html.js';

export type ThemeAssetKind = 'logo' | 'image' | 'font';

export type ThemeValidationContext = {
  assetOrigin: string;
  assetIds: Set<string>;
  assetKinds: Map<string, ThemeAssetKind>;
};

export type ThemeProblem = { path: string; message: string };

export type ThemeValidation =
  | { ok: true; document: ThemeDocument; css: { css: string; hash: string } | null }
  | { ok: false; problems: ThemeProblem[] };

type Path = (string | number)[];
type AnyBlock = ThemeBlock | ThemeLeafBlock;

const IMAGE_KINDS: readonly ThemeAssetKind[] = ['logo', 'image'];
const FONT_KINDS: readonly ThemeAssetKind[] = ['font'];

function eachBlock(list: AnyBlock[], path: Path, fn: (b: AnyBlock, path: Path) => void): void {
  list.forEach((b, i) => {
    const p = [...path, i];
    fn(b, p);
    if (b.type === 'columns') {
      b.columns.forEach((col, ci) => eachBlock(col, [...p, 'columns', ci], fn));
    } else if (b.type === 'section') {
      eachBlock(b.blocks, [...p, 'blocks'], fn);
    }
  });
}

/** Every asset reference in the document, with the kinds it may point at. */
function assetRefs(doc: ThemeDocument): Array<[Path, string, readonly ThemeAssetKind[]]> {
  const refs: Array<[Path, string, readonly ThemeAssetKind[]]> = [];
  const s = doc.settings;
  if (s.logo_asset_id) refs.push([['settings', 'logo_asset_id'], s.logo_asset_id, IMAGE_KINDS]);
  if (s.font.kind === 'asset')
    refs.push([['settings', 'font', 'asset_id'], s.font.asset_id, FONT_KINDS]);
  if (s.background_image_asset_id) {
    refs.push([
      ['settings', 'background_image_asset_id'],
      s.background_image_asset_id,
      IMAGE_KINDS,
    ]);
  }
  for (const key of ['blocks', 'success_blocks'] as const) {
    eachBlock(doc[key], [key], (b, p) => {
      if ((b.type === 'image' || b.type === 'banner') && b.asset_id) {
        refs.push([[...p, 'asset_id'], b.asset_id, IMAGE_KINDS]);
      } else if (b.type === 'section' && b.background_asset_id) {
        refs.push([[...p, 'background_asset_id'], b.background_asset_id, IMAGE_KINDS]);
      } else if (b.type === 'trust_badges') {
        b.badges.forEach((badge, i) => {
          if (badge.kind === 'asset') {
            refs.push([[...p, 'badges', i, 'asset_id'], badge.asset_id, IMAGE_KINDS]);
          }
        });
      }
    });
  }
  return refs;
}

/**
 * Full save-time check of a theme document: schema, palette contrast, asset references, custom
 * HTML (replaced by its sanitised form) and custom CSS (scoped). Problems carry a dotted path.
 */
export function validateThemeDocument(doc: unknown, ctx: ThemeValidationContext): ThemeValidation {
  const parsed = ThemeDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const document = structuredClone(parsed.data);
  const problems: ThemeProblem[] = [];
  const add = (path: Path, message: string) => problems.push({ path: path.join('.'), message });

  for (const mode of ['light', 'dark'] as const) {
    const palette = document.settings.palettes[mode];
    if (palette)
      findContrastProblems(palette).forEach((m) => add(['settings', 'palettes', mode], m));
  }

  for (const [path, id, kinds] of assetRefs(document)) {
    const kind = ctx.assetKinds.get(id);
    if (!ctx.assetIds.has(id) || kind === undefined) {
      add(path, "This file can't be found — upload it again");
    } else if (!kinds.includes(kind)) {
      add(
        path,
        kinds === FONT_KINDS
          ? 'This file must be an uploaded font'
          : 'This file must be an uploaded image or logo',
      );
    }
  }

  for (const key of ['blocks', 'success_blocks'] as const) {
    eachBlock(document[key], [key], (b, p) => {
      if (b.type !== 'custom_html') return;
      const r = sanitizeThemeHtml(b.html, ctx.assetOrigin);
      if (r.ok) b.html = r.html;
      else r.problems.forEach((m) => add([...p, 'html'], m));
    });
  }

  let css: { css: string; hash: string } | null = null;
  if (document.custom_css !== undefined && document.custom_css.trim() !== '') {
    const r = scopeThemeCss(document.custom_css, ctx.assetOrigin);
    if (r.ok) css = r.css === '' ? null : { css: r.css, hash: r.hash };
    else r.problems.forEach((p) => add(['custom_css'], `Line ${p.line}: ${p.message}`));
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, document, css };
}
