import Link from 'next/link';
import { TendrLogo } from '@/components/TendrLogo';

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="brand">
        <TendrLogo size={28} className="brand-logo" />
        Tendr
      </Link>      <nav className="nav" aria-label="Primary">
        <Link href="/demo">Demo</Link>
        <Link href="/dashboard">Dashboard</Link>
        <a href="http://localhost:3001" rel="noreferrer">
          Docs
        </a>
      </nav>
    </header>
  );
}
