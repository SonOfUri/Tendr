import Link from 'next/link';

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="brand">
        Tendr
      </Link>
      <nav className="nav" aria-label="Primary">
        <Link href="/dashboard">Dashboard</Link>
        <a href="http://localhost:3001" rel="noreferrer">
          Docs
        </a>
      </nav>
    </header>
  );
}
