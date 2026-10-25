'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { api, errorMessage, isSignedOut, setStoreContext, type Me } from '@/lib/api';
import { rememberPendingInvite } from '@/lib/navigation';

export default function InvitePage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const path = `/invite/${encodeURIComponent(token)}`;
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>('/v1/me', { store: false })
      .then(setMe)
      .catch((err) => {
        if (isSignedOut(err)) setMe(null);
        else setError(errorMessage(err));
      });
  }, []);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ merchantId: string }>('/v1/invites/accept', {
        method: 'POST',
        json: { token },
        store: false,
      });
      setStoreContext({ merchantId: res.merchantId, livemode: false });
      router.replace('/dashboard');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (me === undefined && !error) {
    return (
      <div className="card">
        <Spinner label="Loading your invite" />
      </div>
    );
  }

  if (me === null) {
    return (
      <div className="card">
        <h1>You’re invited to a store on Tendr</h1>
        <p className="muted">
          Sign in to accept. New to Tendr? Sign up with the email this invite was sent to; we’ll
          bring you back here once your passkey is set up.
        </p>
        <div className="cta-row">
          <Link href={`/login?next=${encodeURIComponent(path)}`}>
            <Button>Sign in</Button>
          </Link>
          <Link href="/signup" onClick={() => rememberPendingInvite(path)}>
            <Button variant="secondary">Sign up</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Join the store</h1>
      {me && (
        <p className="muted">
          You’re signed in as <strong>{me.user.email}</strong>. The invite must have been sent to
          this email.
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button onClick={accept} disabled={busy || !me}>
        {busy ? 'Joining…' : 'Accept invite'}
      </Button>
    </div>
  );
}
