import { describe, expect, it } from 'vitest';
import {
  containsAddressLike,
  containsSendInstruction,
  contrastRatio,
  findButtonWordsProblem,
  findContrastProblems,
  findCountdownLabelProblem,
  ISO_4217_CODES,
  maskAddressLike,
  namesMatch,
} from './theme-text.js';

const EVM = '0x' + 'ab12'.repeat(10);

describe('theme text rules', () => {
  it('button words: rejects digits, currency symbols and codes', () => {
    for (const bad of ['Pay $1', 'Give ₦', 'Pay 5', 'Pay ٣', 'Pay usd now', 'Pay {total}']) {
      expect(findButtonWordsProblem(bad), bad).not.toBeNull();
    }
    for (const ok of ['Give {amount}', 'Complete purchase', 'Get my gems ⚡']) {
      expect(findButtonWordsProblem(ok), ok).toBeNull();
    }
  });

  it('exposes the ISO 4217 codes', () => {
    expect(ISO_4217_CODES).toContain('USD');
    expect(ISO_4217_CODES).toContain('NGN');
  });

  it('detects address-like text', () => {
    const hits = [
      `send to ${EVM}`,
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      'a'.repeat(32) + 'b'.repeat(32),
      'kola.near',
    ];
    for (const s of hits) expect(containsAddressLike(s), s).toBe(true);
    expect(containsAddressLike('Ships in 2 days from Lagos')).toBe(false);
    expect(containsAddressLike('Order #A12345')).toBe(false);
    expect(containsAddressLike('Internationalizationandmoreletters')).toBe(false);
  });

  it('maskAddressLike replaces only the address', () => {
    expect(maskAddressLike(`send ${EVM} now`)).toBe('send ••• now');
    expect(maskAddressLike('plain text')).toBe('plain text');
  });

  it('detects send instructions', () => {
    expect(containsSendInstruction('send USDC to this wallet address')).toBe(true);
    expect(containsSendInstruction('Transfer funds to account 12')).toBe(true);
    expect(containsSendInstruction('we send orders to Abuja')).toBe(false);
  });

  it('countdown labels cannot imitate the payment timer', () => {
    for (const bad of ['Offer expires in', 'Session ends', 'Time left', 'Pay within', 'Deadline']) {
      expect(findCountdownLabelProblem(bad), bad).not.toBeNull();
    }
    expect(findCountdownLabelProblem('Sale ends in')).toBeNull();
  });

  it('namesMatch ignores case punctuation and suffixes', () => {
    expect(namesMatch('Lagos Leather Co.', 'lagos leather')).toBe(true);
    expect(namesMatch('Acme S.A.', 'ACME')).toBe(true);
    expect(namesMatch('Kola Kicks', 'Kola Enterprises Ltd')).toBe(false);
  });

  it('contrastRatio matches WCAG examples', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('findContrastProblems flags low contrast', () => {
    const ok = { accent: '#4035f5', background: '#ffffff', surface: '#f3f4fb', text: '#080d1b' };
    expect(findContrastProblems(ok)).toEqual([]);
    expect(findContrastProblems({ ...ok, text: '#aaaaaa' }).length).toBeGreaterThan(0);
    expect(findContrastProblems({ ...ok, accent: '#f0f0f0' }).length).toBe(1);
  });
});
