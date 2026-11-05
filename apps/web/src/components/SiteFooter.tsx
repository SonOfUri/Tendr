import Link from 'next/link';
import { TendrLogo } from '@/components/TendrLogo';
import { ThemeMenu } from '@/components/ThemeToggle';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="site-footer-brand">
        <TendrLogo size={22} />
        Tendr — One checkout. Every way to pay.
      </p>
      <ThemeMenu />
      <p className="site-footer-links">
        <Link href="/privacy">Privacy</Link>
        {' · '}
        <Link href="/terms">Terms</Link>
      </p>
      <p className="muted">
        Test mode never moves real funds. NEAR Intents is an optional execution integration.
      </p>
    </footer>
  );
}
