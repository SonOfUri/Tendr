/**
 * The small Markdown subset `rich_text` blocks support: **bold**, *italic*, https links,
 * paragraphs and lists. Every character of the source is HTML-escaped before any tag is added,
 * so the output can only ever contain the tags this file writes.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Whether the tags this file adds are properly nested in `html` (so wrapping it stays valid). */
function nestsCleanly(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)(strong|em)>/g)) {
    if (m[1] === '') stack.push(m[2]!);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

const EMPHASIS: Array<[RegExp, 'strong' | 'em']> = [
  [/()\*\*(?=[^\s*])([^*]+?)\*\*/g, 'strong'],
  [/(^|[^\w])__(?=[^\s_])([^_]+?)__(?!\w)/g, 'strong'],
  [/()\*(?=[^\s*])([^*]+?)\*/g, 'em'],
  [/(^|[^\w])_(?=[^\s_])([^_]+?)_(?!\w)/g, 'em'],
];

/** Emphasis on already-escaped text (escaping never produces `*` or `_`). */
function emphasis(escaped: string): string {
  let out = escaped;
  for (const [re, tag] of EMPHASIS) {
    out = out.replace(re, (whole, lead: string, body: string) =>
      nestsCleanly(body) ? `${lead}<${tag}>${body}</${tag}>` : whole,
    );
  }
  return out;
}

function httpsHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const href = httpsHref(m[2]!);
    if (href === null) continue;
    out += emphasis(escapeHtml(text.slice(last, m.index)));
    out += `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${emphasis(escapeHtml(m[1]!))}</a>`;
    last = m.index + m[0].length;
  }
  return out + emphasis(escapeHtml(text.slice(last)));
}

const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d{1,9}[.)]\s+(.*)$/;

export function renderMarkdownSubset(md: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  type List = { tag: 'ul' | 'ol'; items: string[] };
  let list = null as List | null;

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list)
      out.push(
        `<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`,
      );
    list = null;
  };

  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const ul = UL_ITEM.exec(line);
    const ol = ul ? null : OL_ITEM.exec(line);
    const item = ul ?? ol;
    if (item) {
      const tag = ul ? 'ul' : 'ol';
      flushParagraph();
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(item[1]!.trim());
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return out.join('');
}
