import { describe, expect, it } from 'vitest';
import { tendrShopperTheme, themeDisplayName, themeLogoUrl } from './brand';

describe('theme brand', () => {
  it('reads the store name and logo from the theme', () => {
    const theme = tendrShopperTheme('Bean Shop', 'https://assets.test/logo.png');
    theme.document.settings.display_name = 'Beans & Co';
    expect(themeDisplayName(theme)).toBe('Beans & Co');
    expect(themeLogoUrl(theme)).toBe('https://assets.test/logo.png');
  });

  it('no logo when the theme has none or its asset is missing', () => {
    expect(themeLogoUrl(tendrShopperTheme('Bean Shop'))).toBeNull();
    const theme = tendrShopperTheme('Bean Shop', 'https://assets.test/logo.png');
    theme.assets = {};
    expect(themeLogoUrl(theme)).toBeNull();
  });
});
