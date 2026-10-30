// Brand blocks: header (logo and display name), social links, footer links.
import type { ShopperTheme, ThemeLeafBlock } from '@tendr/contracts';
import type { ReactNode } from 'react';
import { themeDisplayName, themeLogoUrl } from '@/lib/checkout/brand';

type Of<T extends ThemeLeafBlock['type']> = Extract<ThemeLeafBlock, { type: T }>;

const NETWORKS: Record<Of<'social_links'>['links'][number]['network'], string> = {
  instagram: 'Instagram',
  x: 'X',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  youtube: 'YouTube',
  website: 'Website',
};

export function header(block: Of<'header'>, theme: ShopperTheme): ReactNode {
  const logo = block.show_logo ? themeLogoUrl(theme) : null;
  const name = block.show_name ? themeDisplayName(theme) : null;
  if (!logo && !name) return null;
  return (
    <div className="tdr-header">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element -- Tendr asset origin
        <img className="tdr-header-logo" src={logo} alt={name ? '' : themeDisplayName(theme)} />
      ) : null}
      {name ? <span className="tdr-header-name">{name}</span> : null}
    </div>
  );
}

export function socialLinks(block: Of<'social_links'>): ReactNode {
  if (!block.links.length) return null;
  return (
    <ul className="tdr-social-links">
      {block.links.map((l, i) => (
        <li key={i}>
          <a href={l.url} target="_blank" rel="noopener noreferrer" data-network={l.network}>
            {NETWORKS[l.network]}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function footerLinks(block: Of<'footer_links'>): ReactNode {
  if (!block.links.length) return null;
  return (
    <ul className="tdr-footer-links">
      {block.links.map((l, i) => (
        <li key={i}>
          <a href={l.url} target="_blank" rel="noopener noreferrer">
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
