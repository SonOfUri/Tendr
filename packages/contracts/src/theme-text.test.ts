import { describe, expect, it } from 'vitest';
import {
  containsAddressLike,
  containsDistinctiveAddressLike,
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

  it('ignores invisible format characters that split an address', () => {
    const zw = (x: string, ch: string) => x.slice(0, 10) + ch + x.slice(10);
    for (const ch of ['\u200b', '\u00ad', '\u2060', '\ufeff', '\u200e', '\u200d']) {
      expect(containsAddressLike(zw(EVM, ch)), JSON.stringify(ch)).toBe(true);
      expect(maskAddressLike(`send ${zw(EVM, ch)} now`)).toBe('send ••• now');
    }
    expect(containsAddressLike('kola\u200b.near')).toBe(true);
    expect(containsSendInstruction('se\u00adnd USDC to this wal\u200blet')).toBe(true);
  });

  it('maskAddressLike keeps format characters outside the masked address', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(maskAddressLike(`${family} ${EVM}`)).toBe(`${family} •••`);
    const split = EVM.slice(0, 10) + '​' + EVM.slice(10);
    expect(maskAddressLike(`‏${family} pay ${split}‎!`)).toBe(`‏${family} pay •••‎!`);
    expect(maskAddressLike(`hi ${family}‎`)).toBe(`hi ${family}‎`);
  });

  it('containsDistinctiveAddressLike finds glued-on addresses without \\b', () => {
    expect(containsDistinctiveAddressLike('Walletbc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(
      true,
    );
    expect(
      containsDistinctiveAddressLike('Hello' + 'a'.repeat(32) + 'b'.repeat(32) + 'World'),
    ).toBe(true);
    expect(containsDistinctiveAddressLike('Pickupfrom9a.m.nearthemarket')).toBe(false);
    expect(containsDistinctiveAddressLike('Comein.Nearbyshopsopenat9')).toBe(false);
  });

  it('containsDistinctiveAddressLike skips base58 and NEAR names', () => {
    expect(containsDistinctiveAddressLike(EVM)).toBe(true);
    expect(containsDistinctiveAddressLike('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(containsDistinctiveAddressLike('kola.near')).toBe(false);
    expect(containsDistinctiveAddressLike('a'.repeat(32) + 'b'.repeat(32))).toBe(true);
    expect(containsDistinctiveAddressLike('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toBe(false);
    expect(containsDistinctiveAddressLike('Shipsin2daysfromLagosandAbujatoKano')).toBe(false);
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
