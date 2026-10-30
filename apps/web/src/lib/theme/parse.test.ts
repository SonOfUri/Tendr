import { TENDR_DEFAULT_THEME, type ShopperTheme } from '@tendr/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseShopperTheme } from './parse';

afterEach(() => vi.restoreAllMocks());

function valid(): ShopperTheme {
  return {
    id: 'thm_1',
    version: 3,
    document: TENDR_DEFAULT_THEME('Kola Kicks'),
    rendered: {},
    assets: {},
    css: '.tdr-scope p{color:red}',
    payee: 'Lagos Leather Co.',
    trading_as: 'Kola Kicks',
  };
}

describe('parseShopperTheme', () => {
  it('returns a valid theme unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseShopperTheme(valid(), 'Lagos Leather Co.')).toEqual(valid());
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders default theme when theme fails to parse', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { ...valid(), document: { ...valid().document, blocks: [{ type: 'payment' }] } };
    for (const raw of [broken, null, undefined, 'nope', { id: 1 }]) {
      const theme = parseShopperTheme(raw, 'Lagos Leather Co.');
      expect(theme.id).toBeNull();
      expect(theme.css).toBeNull();
      expect(theme.document).toEqual(TENDR_DEFAULT_THEME('Lagos Leather Co.'));
      expect(theme.payee).toBe('Lagos Leather Co.');
      expect(theme.trading_as).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });
});
