import type { ThemePalette } from './themes.js';

/**
 * ISO 4217 minor units (decimal places) for every currency a store may price in. Covers every code
 * in WooCommerce's default currency list (`get_woocommerce_currencies()`), including its few
 * non-ISO codes (marked), plus current ISO successors. A code missing here is UNSUPPORTED_CURRENCY.
 */
// prettier-ignore
export const ISO_4217_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  AED: 2, AFN: 2, ALL: 2, AMD: 2, ANG: 2, AOA: 2, ARS: 2, AUD: 2, AWG: 2, AZN: 2,
  BAM: 2, BBD: 2, BDT: 2, BGN: 2, BHD: 3, BIF: 0, BMD: 2, BND: 2, BOB: 2, BRL: 2,
  BSD: 2, BTN: 2, BWP: 2, BYN: 2, BZD: 2,
  CAD: 2, CDF: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2, CRC: 2, CUP: 2, CVE: 2, CZK: 2,
  DJF: 0, DKK: 2, DOP: 2, DZD: 2,
  EGP: 2, ERN: 2, ETB: 2, EUR: 2,
  FJD: 2, FKP: 2,
  GBP: 2, GEL: 2, GHS: 2, GIP: 2, GMD: 2, GNF: 0, GTQ: 2, GYD: 2,
  HKD: 2, HNL: 2, HTG: 2, HUF: 2,
  IDR: 2, ILS: 2, INR: 2, IQD: 3, IRR: 2, ISK: 0,
  JMD: 2, JOD: 3, JPY: 0,
  KES: 2, KGS: 2, KHR: 2, KMF: 0, KPW: 2, KRW: 0, KWD: 3, KYD: 2, KZT: 2,
  LAK: 2, LBP: 2, LKR: 2, LRD: 2, LSL: 2, LYD: 3,
  MAD: 2, MDL: 2, MGA: 2, MKD: 2, MMK: 2, MNT: 2, MOP: 2, MRU: 2, MUR: 2, MVR: 2,
  MWK: 2, MXN: 2, MYR: 2, MZN: 2,
  NAD: 2, NGN: 2, NIO: 2, NOK: 2, NPR: 2, NZD: 2,
  OMR: 3,
  PAB: 2, PEN: 2, PGK: 2, PHP: 2, PKR: 2, PLN: 2, PYG: 0,
  QAR: 2,
  RON: 2, RSD: 2, RUB: 2, RWF: 0,
  SAR: 2, SBD: 2, SCR: 2, SDG: 2, SEK: 2, SGD: 2, SHP: 2, SLE: 2, SOS: 2, SRD: 2,
  SSP: 2, STN: 2, SYP: 2, SZL: 2,
  THB: 2, TJS: 2, TMT: 2, TND: 3, TOP: 2, TRY: 2, TTD: 2, TWD: 2, TZS: 2,
  UAH: 2, UGX: 0, USD: 2, UYU: 2, UZS: 2,
  VED: 2, VES: 2, VND: 0, VUV: 0,
  WST: 2,
  XAF: 0, XCD: 2, XOF: 0, XPF: 0,
  YER: 2,
  ZAR: 2, ZMW: 2, ZWG: 2,
  // Retired ISO codes WooCommerce still lists.
  BYR: 0, CUC: 2, HRK: 2, SLL: 2, VEF: 2,
  // Non-ISO codes in WooCommerce's list: Bitcoin, the Crown-dependency pounds (GBP at par),
  // the Iranian toman, the Transnistrian ruble and the renminbi alias. Usable only if the
  // provider quotes them; otherwise FX_RATE_UNAVAILABLE.
  BTC: 8, GGP: 2, IMP: 2, JEP: 2, IRT: 0, PRB: 2, RMB: 2,
});

/** Every ISO 4217 code (and the few non-ISO codes WooCommerce lists) a store may price in. */
export const ISO_4217_CODES: readonly string[] = Object.freeze(Object.keys(ISO_4217_MINOR_UNITS));

const ISO_CODE_SET: ReadonlySet<string> = new Set(ISO_4217_CODES.map((c) => c.toLowerCase()));

/**
 * Button label rule: a label must not carry an amount, currency or placeholder other than
 * `{amount}`, so a theme can never state what the shopper pays. Returns the plain reason, or null.
 */
export function findButtonWordsProblem(s: string): string | null {
  if (/\p{Nd}/u.test(s)) return "Button text can't contain numbers";
  if (/\p{Sc}/u.test(s)) return "Button text can't contain currency symbols";
  const words = s.toLowerCase().split(/[^\p{L}\p{M}]+/u);
  if (words.some((w) => w.length > 0 && ISO_CODE_SET.has(w))) {
    return "Button text can't contain currency codes";
  }
  const placeholders = s.match(/\{[^}]*\}/g) ?? [];
  if (placeholders.some((p) => p !== '{amount}') || /[{}]/.test(s.replace(/\{amount\}/g, ''))) {
    return 'Button text can only use the {amount} placeholder';
  }
  return null;
}

/** Wallet-address shapes, most specific first. Each is global so one list drives test and mask. */
function addressPatterns(): RegExp[] {
  return [
    /0x[0-9a-fA-F]{40}/g,
    /\b(?:bc1|tb1)[02-9ac-hj-np-z]{11,87}\b/gi,
    /\b[0-9a-f]{64}\b/g,
    /\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|testnet|tg)\b/gi,
    /\b[1-9A-HJ-NP-Za-km-z]{25,44}\b/g,
  ];
}

const BASE58_INDEX = 4;

function isBase58Address(m: string): boolean {
  return /\d/.test(m) && /[A-Za-z]/.test(m);
}

/**
 * Removes invisible format characters (Unicode `Cf`: zero-width space/joiners, soft hyphen, word
 * joiner, BOM, bidi marks, …) that could split an address so the patterns below miss it.
 */
export function stripFormatChars(s: string): string {
  return s.replace(/\p{Cf}/gu, '');
}

export function containsAddressLike(input: string): boolean {
  const s = stripFormatChars(input);
  return addressPatterns().some((re, i) => {
    for (const m of s.matchAll(re)) {
      if (i !== BASE58_INDEX || isBase58Address(m[0])) return true;
    }
    return false;
  });
}

/**
 * Unanchored versions of the shapes that ordinary prose never forms, even with its spaces
 * removed: EVM, bech32 and NEAR implicit (64-hex). For text whose tags and whitespace were
 * removed, where neighbouring words get glued on so a `\b` boundary can't be relied on. Base58
 * and NEAR names are left out: prose like "9 a.m. near the market" forms them once its spaces go.
 */
function distinctivePatterns(): RegExp[] {
  return [/0x[0-9a-fA-F]{40}/, /(?:bc1|tb1)[02-9ac-hj-np-z]{11,87}/i, /[0-9a-f]{64}/];
}

/**
 * Only EVM, bech32 and NEAR-implicit shapes, unanchored. Safe to run on text with tags and
 * whitespace removed (base58 and NEAR names are not checked: prose forms them).
 */
export function containsDistinctiveAddressLike(input: string): boolean {
  const s = stripFormatChars(input);
  return distinctivePatterns().some((re) => re.test(s));
}

/**
 * Replaces each address-like run with `•••`. Invisible format characters are ignored when
 * matching (so a split address is still masked whole) but kept everywhere outside a masked run,
 * so emoji sequences and bidi marks in the rest of the text survive.
 */
export function maskAddressLike(s: string): string {
  // Visible characters, and where each one sits in `s` (UTF-16 offsets).
  let visible = '';
  const at: number[] = [];
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (!/\p{Cf}/u.test(ch)) {
      for (let k = 0; k < ch.length; k += 1) at.push(i + k);
      visible += ch;
    }
    i += ch.length;
  }

  const spans: Array<[number, number]> = [];
  addressPatterns().forEach((re, i) => {
    for (const m of visible.matchAll(re)) {
      if (i === BASE58_INDEX && !isBase58Address(m[0])) continue;
      spans.push([m.index, m.index + m[0].length]);
    }
  });
  if (spans.length === 0) return s;

  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  let out = '';
  let cursor = 0;
  for (const [a, b] of merged) {
    const from = at[a]!;
    const to = at[b - 1]! + 1;
    out += s.slice(cursor, from) + '•••';
    cursor = to;
  }
  return out + s.slice(cursor);
}

const SEND_INSTRUCTION =
  /\b(?:send|transfer|deposit|pay)\b[^.\n]{0,60}\bto\b[^.\n]{0,20}(?:address|wallet|account|0x|bc1)/i;

/** "Send USDC to this wallet" style phrasing a merchant could use to redirect a payment. */
export function containsSendInstruction(s: string): boolean {
  return SEND_INSTRUCTION.test(stripFormatChars(s));
}

const COUNTDOWN_BANNED =
  /expire|expiring|expiry|session|deadline|time left|pay within|left to pay/i;

/** A countdown may not imitate the payment timer. Returns the plain reason, or null. */
export function findCountdownLabelProblem(s: string): string | null {
  return COUNTDOWN_BANNED.test(s)
    ? "Countdown text can't look like the payment timer (avoid words like expires, session, deadline, time left)"
    : null;
}

const NAME_SUFFIXES: ReadonlySet<string> = new Set([
  'ltd',
  'limited',
  'llc',
  'inc',
  'co',
  'company',
  'plc',
  'gmbh',
  'sa',
  'bv',
]);

function normalizeName(s: string): string {
  const tokens = s
    .toLowerCase()
    .replace(/\./g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join('');
}

/** Whether a theme's display name is the account's name (ignoring case, punctuation, suffixes). */
export function namesMatch(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Plain-language contrast failures for one palette (empty when it passes). */
export function findContrastProblems(p: ThemePalette): string[] {
  const out: string[] = [];
  if (contrastRatio(p.text, p.background) < 4.5) {
    out.push('Text is too hard to read on the background (needs a contrast of at least 4.5:1)');
  }
  if (contrastRatio(p.text, p.surface) < 4.5) {
    out.push('Text is too hard to read on cards (needs a contrast of at least 4.5:1)');
  }
  if (contrastRatio(p.accent, p.background) < 3) {
    out.push('The accent colour is too faint on the background (needs a contrast of at least 3:1)');
  }
  return out;
}
