'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Spinner } from '@tendr/ui';
import { AuthCta } from '@/components/login/AuthCta';
import { AuthStage } from '@/components/login/AuthStage';
import { api, errorMessage, isSignedOut, setStoreContext, type Me } from '@/lib/api';
import { rememberPendingInvite } from '@/lib/navigation';

function InvitePage() {
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
    return <Spinner label="Loading your invite" />;
  }

  if (me === null) {
    return (
      <>
        <p className="login-panel-eyebrow">Invite</p>
        <h1>You’re invited to a business on Tendr</h1>
        <p className="login-panel-lead">
          Sign in to accept. New to Tendr? Sign up with the email this invite was sent to; we’ll
          bring you back here once your passkey is set up.
        </p>
        <Link href={`/login?next=${encodeURIComponent(path)}`}>
          <AuthCta>Sign in</AuthCta>
        </Link>
        <p className="login-panel-foot">
          New to Tendr?{' '}
          <Link href="/signup" onClick={() => rememberPendingInvite(path)}>
            Sign up
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <p className="login-panel-eyebrow">Invite</p>
      <h1>Join the business</h1>
      {me && (
        <p className="login-panel-lead">
          You’re signed in as <strong>{me.user.email}</strong>. The invite must have been sent to
          this email.
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <AuthCta onClick={accept} disabled={busy || !me}>
        {busy ? 'Joining…' : 'Accept invite'}
      </AuthCta>
    </>
  );
}

export default function InviteRoute() {
  return (
    <AuthStage>
      <InvitePage />
    </AuthStage>
  );
}
