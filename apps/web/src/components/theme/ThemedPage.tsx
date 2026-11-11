'use client';

// The root of a themed shopper page (checkout, payment link, preview): `.tdr-theme` carries the
// theme variables (ThemeStyles) and `data-scheme`, which picks Tendr's fixed state colours for the
// palette shown (light or dark by its background).
import type { ShopperTheme } from '@tendr/contracts';
import type { ReactNode } from 'react';
import { useScheme } from '@/lib/theme/use-scheme';
import { themeDataScheme, themeScheme, type Scheme } from '@/lib/theme/vars';
import { ThemeStyles } from './ThemeStyles';

export function ThemedPage({
  theme,
  scheme: forced,
  page = true,
  children,
}: {
  theme: ShopperTheme;
  /** Draw in this scheme instead of the shopper's preference (the preview's `opts.scheme`). */
  scheme?: Scheme;
  /** Paint the document body behind the checkout. Off for in-dashboard embeds. */
  page?: boolean;
  children: ReactNode;
}) {
  const mode = theme.document.settings.mode;
  const preferred = useScheme(mode);
  const scheme = forced ? themeScheme(mode, forced) : preferred;
  return (
    <div className="tdr-theme tdr-page" data-scheme={themeDataScheme(theme, scheme)}>
      <ThemeStyles theme={theme} scheme={scheme} page={page} />
      {children}
    </div>
  );
}
