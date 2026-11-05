import Link from 'next/link';

/** Rendered only by the explicit local launcher connected to the deployed API. */
export function LocalLiveBanner() {
  return (
    <aside className="card stack" aria-label="Local dashboard connected to live API">
      <strong>Local dashboard · Live API</strong>
      <p>
        This window uses your deployed Tendr account. Test mode uses test funds; Live mode uses real
        funds.
      </p>
      <p className="muted small">
        Sign in with your Tendr passkey, or create an account. Open email verification links in this
        window by pasting them into its address bar. Accounts from the local simulator are separate.
      </p>
      <p>
        <Link href="/dashboard">Dashboard</Link> ·{' '}
        <Link href="/settings/api-console">API console</Link>
      </p>
    </aside>
  );
}
