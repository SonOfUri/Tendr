import { createHash } from 'node:crypto';
import {
  containsAddressLike,
  containsSendInstruction,
  THEME_CSS_MAX_BYTES,
} from '@tendr/contracts';
import * as csstree from 'css-tree';

/**
 * Merchant CSS validation. Every rule is parsed with css-tree (never regex-filtered), checked
 * against the rules below, and regenerated from the AST so only what was checked is served.
 *
 * The checkout page wraps each merchant block as `.tdr-wrap > .tdr-scope > .tdr-content`; the
 * sealed payment block sits outside every `.tdr-scope`. Every merchant selector is rewritten to
 * `.tdr-scope <selector>` (a descendant combinator), so it can only ever match elements inside a
 * merchant block. Selectors that name the page root, shadow hosts or Tendr's own class names, and
 * properties that can lift an element out of its block, are refused with a plain reason.
 */

export const THEME_SCOPE_CLASS = 'tdr-scope';
/** Prefix given to every merchant `@keyframes` name so it can't replace one of Tendr's. */
export const THEME_KEYFRAMES_PREFIX = 'tdrm-';

export type CssProblem = { line: number; message: string };
export type ScopedCss =
  { ok: true; css: string; hash: string } | { ok: false; problems: CssProblem[] };

const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes']);

const FORBIDDEN_TYPE_SELECTORS = new Set(['html', 'body']);
const FORBIDDEN_PSEUDO_CLASSES = new Set(['root', 'host', 'host-context', 'has', 'scope']);
const FORBIDDEN_PSEUDO_ELEMENTS = new Set(['part', 'slotted']);

/** Properties refused outright, compared without any vendor prefix. */
const FORBIDDEN_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ['behavior', "`behavior` isn't allowed — it can run code"],
  ['binding', "`-moz-binding` isn't allowed — it can run code"],
  ['user-modify', "`user-modify` isn't allowed — themes can't make text editable"],
  [
    'view-transition-name',
    "`view-transition-name` isn't allowed — it could draw over the payment details",
  ],
  [
    'view-transition-class',
    "`view-transition-class` isn't allowed — it could draw over the payment details",
  ],
  [
    'anchor-name',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'anchor-scope',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'position-anchor',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'position-area',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'inset-area',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'position-try',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'position-try-fallbacks',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'position-try-options',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'position-try-order',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
  [
    'position-visibility',
    "Anchor positioning isn't allowed — it could move content over the payment details",
  ],
]);

/** Functions refused anywhere in a value, compared without any vendor prefix. */
const FORBIDDEN_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ['expression', "`expression()` isn't allowed — it can run code"],
  ['image-set', "`image-set()` isn't allowed — use `url()` with an uploaded image"],
  ['src', "`src()` isn't allowed — use `url()` with an uploaded image"],
  ['element', "`element()` isn't allowed — it can copy the payment details"],
  ['paint', "`paint()` isn't allowed — it can run code"],
  ['anchor', "`anchor()` isn't allowed — it could move content over the payment details"],
  ['anchor-size', "`anchor-size()` isn't allowed — it could move content over the payment details"],
  ['attr', "`attr()` isn't allowed — CSS can't put text on the page"],
]);

/**
 * Properties that can draw text. CSS may not add text at all (an address can be built from any
 * number of short strings across pseudo-elements or keyframes), so these accept only the values
 * below; anything else gets {@link NO_TEXT}.
 */
const TEXT_DRAWING_PROPERTIES = new Set([
  'content',
  'quotes',
  'list-style',
  'list-style-type',
  'text-overflow',
  'text-emphasis',
  'text-emphasis-style',
  'hyphenate-character',
]);
const CONTENT_KEYWORDS = new Set([
  'none',
  'normal',
  'open-quote',
  'close-quote',
  'no-open-quote',
  'no-close-quote',
]);
/** Functions that could put text (or a value standing in for text) into a drawing property. */
const TEXT_FUNCTIONS = new Set(['var', 'env', 'attr', 'counter', 'counters', 'symbols', 'string']);
const NO_TEXT = "CSS can't add text — put words in a text block instead";

const BREAKS_STYLE_ELEMENT = /<\/style|<!--|<\/?script/i;
const ANGLE_BRACKET = "CSS text and links can't contain `<`";

const TEXT_PROBLEM = "Text can't contain wallet addresses or payment instructions";
const UNREADABLE = "This part of the CSS couldn't be read — check for a missing `{`, `}` or `;`";

function unprefixed(name: string): string {
  return name.toLowerCase().replace(/^-(?:webkit|moz|ms|o)-/, '');
}

function hasReservedPrefix(name: string): boolean {
  return /^(?:tdr|pay)-/i.test(name);
}

function lineOf(node: csstree.CssNode | null | undefined, fallback: number): number {
  return node?.loc?.start.line ?? fallback;
}

class Checker {
  readonly problems: CssProblem[] = [];

  constructor(
    private readonly assetOrigin: string,
    private readonly keyframes: ReadonlySet<string>,
  ) {}

  add(line: number, message: string): void {
    if (!this.problems.some((p) => p.line === line && p.message === message)) {
      this.problems.push({ line, message });
    }
  }

  // -------------------------------------------------------------- selectors

  /** Checks a style rule's selectors; returns false when it can't be scoped. */
  selectorList(prelude: csstree.CssNode, line: number): boolean {
    if (prelude.type !== 'SelectorList') {
      this.add(lineOf(prelude, line), UNREADABLE);
      return false;
    }
    let ok = true;
    prelude.children.forEach((selector) => {
      if (selector.type !== 'Selector') {
        this.add(lineOf(selector, line), UNREADABLE);
        ok = false;
        return;
      }
      if (!this.selector(selector, line)) ok = false;
    });
    return ok;
  }

  private selector(selector: csstree.Selector, line: number): boolean {
    const at = lineOf(selector, line);
    const before = this.problems.length;
    const first = selector.children.first;
    if (first?.type === 'Combinator') {
      this.add(
        at,
        `A selector can't start with \`${first.name.trim() || ' '}\` — it would reach outside your block`,
      );
    }
    const parts = selector.children.toArray();
    const isUniversal = (n: csstree.CssNode) => n.type === 'TypeSelector' && n.name === '*';
    const onlyUniversal =
      parts.some(isUniversal) &&
      parts.every((n) => isUniversal(n) || n.type === 'PseudoElementSelector');
    if (onlyUniversal) {
      this.add(at, "A selector can't be `*` on its own — name the elements you want to style");
    }
    csstree.walk(selector, (node) => this.selectorNode(node, at));
    return this.problems.length === before;
  }

  private selectorNode(node: csstree.CssNode, at: number): void {
    const line = lineOf(node, at);
    switch (node.type) {
      case 'TypeSelector': {
        if (node.name.includes('\\')) {
          this.add(line, "Escaped characters (`\\`) aren't allowed in selectors");
        } else if (node.name.includes('|')) {
          this.add(line, "Namespaced selectors (`|`) aren't allowed");
        } else if (FORBIDDEN_TYPE_SELECTORS.has(node.name.toLowerCase())) {
          this.add(
            line,
            `\`${node.name.toLowerCase()}\` can't be styled — your CSS only applies inside your blocks`,
          );
        }
        break;
      }
      case 'ClassSelector':
      case 'IdSelector': {
        const sigil = node.type === 'ClassSelector' ? '.' : '#';
        if (node.name.includes('\\')) {
          this.add(line, "Escaped characters (`\\`) aren't allowed in selectors");
        } else if (hasReservedPrefix(node.name)) {
          this.add(
            line,
            `\`${sigil}${node.name}\` is reserved for Tendr's checkout and can't be styled`,
          );
        }
        break;
      }
      case 'AttributeSelector': {
        const name = node.name.name.toLowerCase();
        if (node.name.name.includes('\\')) {
          this.add(line, "Escaped characters (`\\`) aren't allowed in selectors");
        }
        const value =
          node.value?.type === 'String'
            ? node.value.value
            : node.value?.type === 'Identifier'
              ? node.value.name
              : '';
        if (value.includes('<')) this.add(line, ANGLE_BRACKET);
        // Substring matchers (`^=`, `*=`, …) could reach Tendr's names, so any mention is refused.
        if ((name === 'class' || name === 'id') && /tdr|pay/i.test(value)) {
          this.add(line, "Selectors can't match Tendr's own class names (`tdr-…`, `pay-…`)");
        }
        break;
      }
      case 'PseudoClassSelector': {
        const name = unprefixed(node.name);
        if (node.name.includes('\\')) {
          this.add(line, "Escaped characters (`\\`) aren't allowed in selectors");
        } else if (name === 'has') {
          this.add(line, "`:has()` isn't allowed — it can reach outside your block");
        } else if (FORBIDDEN_PSEUDO_CLASSES.has(name)) {
          this.add(line, `\`:${name}\` can't be styled — your CSS only applies inside your blocks`);
        }
        break;
      }
      case 'PseudoElementSelector': {
        const name = unprefixed(node.name);
        if (node.name.includes('\\')) {
          this.add(line, "Escaped characters (`\\`) aren't allowed in selectors");
        } else if (FORBIDDEN_PSEUDO_ELEMENTS.has(name) || name.startsWith('view-transition')) {
          this.add(line, `\`::${name}\` isn't allowed — your CSS only applies inside your blocks`);
        }
        break;
      }
      case 'NestingSelector':
        this.add(line, "Nested rules (`&`) aren't supported — write each selector in full");
        break;
      case 'Raw':
        this.add(line, UNREADABLE);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ declarations

  /** Checks every declaration in a block; nested rules and unreadable parts are refused. */
  declarations(block: csstree.Block | csstree.DeclarationList, line: number): void {
    block.children.forEach((child) => {
      const at = lineOf(child, line);
      if (child.type === 'Declaration') {
        this.declaration(child, at);
      } else if (child.type === 'Rule' || child.type === 'Atrule') {
        this.add(at, "Nested rules aren't supported — write each rule at the top level");
      } else {
        this.add(at, UNREADABLE);
      }
    });
  }

  private declaration(decl: csstree.Declaration, line: number): void {
    const raw = decl.property;
    const name = unprefixed(raw);
    if (raw.includes('\\')) {
      this.add(line, "Escaped characters (`\\`) aren't allowed in property names");
      return;
    }
    const forbidden = FORBIDDEN_PROPERTIES.get(name);
    if (forbidden) {
      this.add(line, forbidden);
      return;
    }
    if (name === 'position') this.position(decl, line);
    if (TEXT_DRAWING_PROPERTIES.has(name) && !this.drawsNoText(name, decl.value)) {
      this.add(line, NO_TEXT);
    }
    // Strings anywhere else are checked together too, in case they are ever shown.
    const strings: string[] = [];
    csstree.walk(decl.value, (n) => {
      if (n.type === 'String') strings.push(n.value);
    });
    const joined = strings.join('');
    if (strings.length > 1 && (containsAddressLike(joined) || containsSendInstruction(joined))) {
      this.add(line, TEXT_PROBLEM);
    }
    this.value(decl.value, line);
    if ((name === 'animation' || name === 'animation-name') && decl.value.type === 'Value') {
      decl.value.children.forEach((n) => {
        if (n.type === 'Identifier' && this.keyframes.has(n.name)) {
          n.name = THEME_KEYFRAMES_PREFIX + n.name;
        }
      });
    }
  }

  /** Whether a text-drawing property's value is one of the text-free forms it allows. */
  private drawsNoText(name: string, value: csstree.Value | csstree.Raw): boolean {
    if (value.type !== 'Value') return false;
    const parts = value.children.toArray();
    const ident = (n: csstree.CssNode, allowed: readonly string[]) =>
      n.type === 'Identifier' && allowed.includes(n.name.toLowerCase());
    switch (name) {
      case 'content':
        return parts.every(
          (n) =>
            (n.type === 'Identifier' && CONTENT_KEYWORDS.has(n.name.toLowerCase())) ||
            (n.type === 'String' && n.value === '') ||
            n.type === 'Url' ||
            (n.type === 'Function' && n.name.toLowerCase() === 'counter' && this.plainCounter(n)),
        );
      case 'quotes':
        return parts.length === 1 && ident(parts[0]!, ['none', 'auto']);
      case 'text-overflow':
        return parts.length >= 1 && parts.every((n) => ident(n, ['clip', 'ellipsis']));
      case 'hyphenate-character':
        return parts.length === 1 && ident(parts[0]!, ['auto']);
      default: {
        // list-style(-type), text-emphasis(-style): keywords (and colours / images), no text.
        let ok = true;
        csstree.walk(value, (n) => {
          if (n.type === 'String') ok = false;
          if (n.type === 'Function' && TEXT_FUNCTIONS.has(unprefixed(n.name))) ok = false;
        });
        return ok;
      }
    }
  }

  /** `counter(<ident>)` or `counter(<ident>, <ident>)`: a number, never a string. */
  private plainCounter(fn: csstree.FunctionNode): boolean {
    const args = fn.children.toArray();
    if (args.length === 1) return args[0]!.type === 'Identifier';
    return (
      args.length === 3 &&
      args[0]!.type === 'Identifier' &&
      args[1]!.type === 'Operator' &&
      args[1]!.value === ',' &&
      args[2]!.type === 'Identifier'
    );
  }

  private position(decl: csstree.Declaration, line: number): void {
    if (decl.value.type !== 'Value') return;
    decl.value.children.forEach((n) => {
      if (n.type === 'Identifier') {
        const v = unprefixed(n.name);
        if (v === 'fixed' || v === 'sticky') {
          this.add(line, `\`position: ${v}\` isn't allowed — it could cover the payment details`);
        }
      } else if (n.type === 'Function') {
        this.add(line, `\`position\` can't use \`${n.name}()\` — write the value directly`);
      }
    });
  }

  /** Value-level rules: urls, functions, strings and escapes. Also used for at-rule preludes. */
  value(node: csstree.CssNode, line: number): void {
    csstree.walk(node, (n) => {
      const at = lineOf(n, line);
      switch (n.type) {
        case 'Raw':
          this.add(at, UNREADABLE);
          break;
        case 'Identifier':
          if (n.name.includes('\\'))
            this.add(at, "Escaped characters (`\\`) aren't allowed in values");
          break;
        case 'Function': {
          if (n.name.includes('\\')) {
            this.add(at, "Escaped characters (`\\`) aren't allowed in values");
            break;
          }
          const message = FORBIDDEN_FUNCTIONS.get(unprefixed(n.name));
          if (message) this.add(at, message);
          break;
        }
        case 'Url': {
          const normalized = n.value.includes('<') ? null : this.assetUrl(n.value);
          if (n.value.includes('<')) {
            this.add(at, ANGLE_BRACKET);
          } else if (normalized === null) {
            this.add(at, '`url()` can only point to images and fonts uploaded to Tendr');
          } else {
            n.value = normalized;
          }
          break;
        }
        case 'String':
          if (n.value.includes('<')) this.add(at, ANGLE_BRACKET);
          if (containsAddressLike(n.value) || containsSendInstruction(n.value)) {
            this.add(at, TEXT_PROBLEM);
          }
          break;
        default:
          break;
      }
    });
  }

  /** The normalised URL when it is a full link on the asset origin; null otherwise. */
  private assetUrl(value: string): string | null {
    let url: URL;
    let origin: string;
    try {
      url = new URL(value);
      origin = new URL(this.assetOrigin).origin;
    } catch {
      return null;
    }
    if (url.origin !== origin || url.username !== '' || url.password !== '') return null;
    return url.href;
  }
}

function keyframesName(rule: csstree.Atrule): string | null {
  const children = rule.prelude?.type === 'AtrulePrelude' ? rule.prelude.children.toArray() : [];
  const only = children.length === 1 ? children[0] : undefined;
  if (only?.type !== 'Identifier' || only.name.includes('\\')) return null;
  return only.name;
}

function isKeyframeSelector(selector: csstree.CssNode): boolean {
  if (selector.type !== 'Selector') return false;
  const parts = selector.children.toArray();
  if (parts.length !== 1) return false;
  const p = parts[0]!;
  return (
    p.type === 'Percentage' ||
    (p.type === 'TypeSelector' &&
      (p.name.toLowerCase() === 'from' || p.name.toLowerCase() === 'to'))
  );
}

function checkKeyframes(rule: csstree.Atrule, checker: Checker, line: number): void {
  const name = keyframesName(rule);
  if (name === null) {
    checker.add(line, '`@keyframes` needs a plain name, like `@keyframes fade`');
    return;
  }
  rule.prelude = {
    type: 'AtrulePrelude',
    children: new csstree.List<csstree.CssNode>().fromArray([
      { type: 'Identifier', name: THEME_KEYFRAMES_PREFIX + name },
    ]),
  };
  rule.block?.children.forEach((frame) => {
    const at = lineOf(frame, line);
    if (frame.type !== 'Rule' || frame.prelude.type !== 'SelectorList') {
      checker.add(at, UNREADABLE);
      return;
    }
    if (!frame.prelude.children.toArray().every(isKeyframeSelector)) {
      checker.add(at, 'Keyframes can only use `from`, `to` or percentages');
      return;
    }
    checker.declarations(frame.block, at);
  });
}

function checkChildren(list: csstree.List<csstree.CssNode>, checker: Checker): void {
  list.forEach((node) => {
    const line = lineOf(node, 1);
    if (node.type === 'Rule') {
      if (checker.selectorList(node.prelude, line) && node.prelude.type === 'SelectorList') {
        node.prelude.children.forEach((selector) => {
          if (selector.type !== 'Selector') return;
          selector.children.prependData({ type: 'Combinator', name: ' ' });
          selector.children.prependData({ type: 'ClassSelector', name: THEME_SCOPE_CLASS });
        });
      }
      checker.declarations(node.block, line);
      return;
    }
    if (node.type === 'Atrule') {
      const name = node.name.toLowerCase();
      if (!ALLOWED_AT_RULES.has(name) || node.name.includes('\\')) {
        checker.add(
          line,
          `\`@${node.name}\` isn't allowed — only \`@media\`, \`@supports\` and \`@keyframes\` are`,
        );
        return;
      }
      if (name === 'keyframes') {
        checkKeyframes(node, checker, line);
        return;
      }
      if (node.prelude) checker.value(node.prelude, line);
      if (!node.block) {
        checker.add(line, UNREADABLE);
        return;
      }
      checkChildren(node.block.children, checker);
      return;
    }
    if (node.type === 'Comment') return;
    checker.add(line, UNREADABLE);
  });
}

function collectKeyframeNames(ast: csstree.CssNode): Set<string> {
  const names = new Set<string>();
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      if (node.name.toLowerCase() !== 'keyframes') return;
      const name = keyframesName(node);
      if (name !== null) names.add(name);
    },
  });
  return names;
}

/** Validates merchant CSS and rewrites every selector to stay inside `.tdr-scope`. */
export function scopeThemeCss(css: string, assetOrigin: string): ScopedCss {
  if (new TextEncoder().encode(css).length > THEME_CSS_MAX_BYTES) {
    return { ok: false, problems: [{ line: 1, message: 'CSS is over 50 KB' }] };
  }
  const parseErrors: CssProblem[] = [];
  const ast = csstree.parse(css, {
    positions: true,
    parseCustomProperty: true,
    onParseError: (e) =>
      parseErrors.push({ line: (e as { line?: number }).line ?? 1, message: UNREADABLE }),
  });
  const checker = new Checker(assetOrigin, collectKeyframeNames(ast));
  for (const p of parseErrors) checker.add(p.line, p.message);
  if (ast.type === 'StyleSheet') checkChildren(ast.children, checker);

  if (checker.problems.length > 0) {
    return { ok: false, problems: [...checker.problems].sort((a, b) => a.line - b.line) };
  }
  const out = csstree.generate(ast);
  // Safety net: the CSS is served inside a <style> element, which these sequences could end.
  if (BREAKS_STYLE_ELEMENT.test(out)) {
    return { ok: false, problems: [{ line: 1, message: ANGLE_BRACKET }] };
  }
  return { ok: true, css: out, hash: createHash('sha256').update(out).digest('hex') };
}

/** Validates an inline `style` attribute with the same property rules as a stylesheet. */
export function checkInlineStyle(
  style: string,
  assetOrigin: string,
): { ok: true; style: string } | { ok: false; problems: string[] } {
  let failed = false;
  const ast = csstree.parse(style, {
    context: 'declarationList',
    positions: true,
    parseCustomProperty: true,
    onParseError: () => {
      failed = true;
    },
  });
  const checker = new Checker(assetOrigin, new Set());
  if (failed) checker.add(1, UNREADABLE);
  if (ast.type === 'DeclarationList') checker.declarations(ast, 1);
  else checker.add(1, UNREADABLE);
  if (checker.problems.length > 0) {
    return { ok: false, problems: [...new Set(checker.problems.map((p) => p.message))] };
  }
  const out = csstree.generate(ast);
  if (BREAKS_STYLE_ELEMENT.test(out)) return { ok: false, problems: [ANGLE_BRACKET] };
  return { ok: true, style: out };
}
