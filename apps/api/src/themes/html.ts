import {
  containsAddressLike,
  containsSendInstruction,
  THEME_HTML_MAX_BYTES,
} from '@tendr/contracts';
import sanitizeHtml from 'sanitize-html';
import { checkInlineStyle } from './css.js';

/**
 * Custom HTML block sanitiser. An allowlist of formatting tags survives; anything that could run
 * code, collect shopper input or load from outside Tendr's asset origin is refused with a reason
 * (rather than silently stripped) so the merchant learns why their HTML was rejected.
 */

export type SanitizedHtml = { ok: true; html: string } | { ok: false; problems: string[] };

// prettier-ignore
const ALLOWED_TAGS = [
  'p', 'br', 'span', 'div', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'h2', 'h3', 'h4', 'ul',
  'ol', 'li', 'blockquote', 'a', 'img', 'figure', 'figcaption', 'hr', 'table', 'thead', 'tbody',
  'tr', 'th', 'td',
];

const CODE = "custom HTML can't run code";
const INPUT = "custom HTML can't collect shopper input";
const EMBED = "custom HTML can't load other pages or files";

/** Tags refused outright, with the reason the merchant sees. */
const REJECTED_TAGS: ReadonlyMap<string, string> = new Map([
  ['script', CODE],
  ['noscript', CODE],
  ['template', CODE],
  ['svg', CODE],
  ['math', CODE],
  ['style', "custom HTML can't carry its own stylesheet — use the theme's custom CSS"],
  ['form', INPUT],
  ['input', INPUT],
  ['button', INPUT],
  ['select', INPUT],
  ['option', INPUT],
  ['datalist', INPUT],
  ['textarea', INPUT],
  ['keygen', INPUT],
  ['output', INPUT],
  ['dialog', INPUT],
  ['iframe', EMBED],
  ['frame', EMBED],
  ['frameset', EMBED],
  ['object', EMBED],
  ['embed', EMBED],
  ['applet', EMBED],
  ['portal', EMBED],
  ['fencedframe', EMBED],
  ['link', EMBED],
  ['meta', EMBED],
  ['base', EMBED],
]);

const TEXT_PROBLEM = "Text can't contain wallet addresses or payment instructions";

/** Tags whose boundaries break a line, so text either side of them isn't read as one run. */
const BLOCK_BOUNDARY =
  /<\/?(?:p|br|div|h2|h3|h4|ul|ol|li|blockquote|figure|figcaption|hr|table|thead|tbody|tr|th|td)\b[^>]*>/gi;

function isScriptUrl(value: string): boolean {
  // Browsers ignore whitespace and control characters inside a URL scheme.
  // eslint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000- \u007f]/g, '').toLowerCase();
  return /^(?:javascript|vbscript):/.test(compact);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Visible text of sanitised HTML: inline tags join their text, block tags break it. */
function visibleText(html: string): string {
  const stripped = html.replace(BLOCK_BOUNDARY, '\n').replace(/<[^>]*>/g, '');
  return decodeBasicEntities(stripped);
}

export function sanitizeThemeHtml(html: string, assetOrigin: string): SanitizedHtml {
  if (new TextEncoder().encode(html).length > THEME_HTML_MAX_BYTES) {
    return { ok: false, problems: ['HTML block is over 20 KB'] };
  }
  const assetOriginNormalized = originOf(assetOrigin);
  const assetScheme = assetOriginNormalized
    ? new URL(assetOriginNormalized).protocol.slice(0, -1)
    : 'https';

  const problems: string[] = [];
  const add = (p: string) => {
    if (!problems.includes(p)) problems.push(p);
  };
  const altTexts: string[] = [];

  const onOpenTag = (name: string, attribs: Record<string, string>) => {
    const tag = name.toLowerCase();
    const rejected = REJECTED_TAGS.get(tag);
    if (rejected) add(`\`<${tag}>\` isn't allowed — ${rejected}`);

    for (const [rawAttr, value] of Object.entries(attribs)) {
      const attr = rawAttr.toLowerCase();
      if (attr.startsWith('on')) add(`\`${attr}\` isn't allowed — ${CODE}`);
      if (attr === 'contenteditable') add(`\`contenteditable\` isn't allowed — ${INPUT}`);
      if (isScriptUrl(value)) add(`\`javascript:\` links aren't allowed — ${CODE}`);
    }
    if (!ALLOWED_TAGS.includes(tag)) return;

    for (const cls of (attribs.class ?? '').split(/\s+/)) {
      if (/^(?:tdr|pay)-/i.test(cls)) {
        add(`The class \`${cls}\` is reserved for Tendr's checkout`);
      }
    }
    if (attribs.style !== undefined) {
      const style = checkInlineStyle(attribs.style, assetOrigin);
      if (!style.ok) style.problems.forEach((p) => add(`In a \`style\` attribute: ${p}`));
    }
    if (tag === 'a' && attribs.href !== undefined && !isScriptUrl(attribs.href)) {
      let https = false;
      try {
        https = new URL(attribs.href).protocol === 'https:';
      } catch {
        https = false;
      }
      if (!https) add('Links must start with https://');
    }
    if (tag === 'img') {
      if (attribs.src !== undefined && !isScriptUrl(attribs.src)) {
        if (assetOriginNormalized === null || originOf(attribs.src) !== assetOriginNormalized) {
          add('Images must be uploaded to Tendr — links to other sites are not allowed');
        }
      }
      if (attribs.alt !== undefined) altTexts.push(attribs.alt);
    }
  };

  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['class', 'style'],
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt'],
    },
    allowedSchemes: ['https'],
    allowedSchemesByTag: { img: [assetScheme] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    disallowedTagsMode: 'discard',
    onOpenTag,
    transformTags: {
      '*': (tagName, attribs) => {
        const next = { ...attribs };
        if (next.style !== undefined) {
          const style = checkInlineStyle(next.style, assetOrigin);
          if (style.ok && style.style !== '') next.style = style.style;
          else delete next.style;
        }
        if (tagName === 'a') {
          next.rel = 'noopener noreferrer';
          next.target = '_blank';
        }
        return { tagName, attribs: next };
      },
    },
  });

  const text = [visibleText(clean), ...altTexts];
  if (text.some((t) => containsAddressLike(t) || containsSendInstruction(t))) add(TEXT_PROBLEM);

  return problems.length > 0 ? { ok: false, problems } : { ok: true, html: clean };
}
