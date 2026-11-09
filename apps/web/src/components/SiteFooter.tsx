import Link from 'next/link';
import { TendrLogo } from '@/components/TendrLogo';
import { ThemeMenu } from '@/components/ThemeToggle';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-row">
        <p className="site-footer-brand">
          <TendrLogo size={22} />
          <span className="site-footer-tagline">Tendr — One checkout. Every way to pay.</span>
        </p>
        <ThemeMenu />
        <p className="site-footer-links">
          <Link href="/privacy">Privacy</Link>
          {' · '}
          <Link href="/terms">Terms</Link>
        </p>
      </div>
      <p className="muted site-footer-note">
        Test mode never moves real funds. NEAR Intents is an optional execution integration.
      </p>
    </footer>
  );
}
