import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>Tendr — One checkout. Every way to pay.</p>
      <p>
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
