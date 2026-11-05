import Link from 'next/link';
import { TendrLogo } from '@/components/TendrLogo';

const LANDING_URL = 'https://usetendr.tech';
const DEMO_URL = 'https://demo.usetendr.tech';

export function LoginPillNav() {
  return (
    <header className="login-pill-nav" aria-label="Tendr">
      <a href={LANDING_URL} className="login-pill-nav-logo" aria-label="Tendr home">
        <TendrLogo size={22} decorative={false} tone="black" />
      </a>

      <nav className="login-pill-nav-links" aria-label="Primary">
        <a href={LANDING_URL}>Home</a>
        <a href={DEMO_URL}>Demo</a>
        <a href="http://localhost:3001" rel="noreferrer">
          Docs
        </a>
      </nav>

      <Link href="/dashboard" className="login-pill-nav-cta">
        <span className="login-pill-nav-cta-label">Dashboard</span>
      </Link>
    </header>
  );
}
