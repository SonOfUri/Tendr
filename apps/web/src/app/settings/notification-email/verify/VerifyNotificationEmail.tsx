'use client';

// Posts the link's token once (`POST /v1/settings/notification-email/verify`, public), then shows
// the result. The token is dropped from the address bar as soon as it is read.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from '@tendr/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { verifyCopy } from '@/lib/notification-email';

type State =
  | { k: 'working' }
  | { k: 'done'; email: string; store: string }
  | { k: 'invalid' }
  | { k: 'error'; message: string };

const SETTINGS = '/dashboard/settings/checkout';

export function VerifyNotificationEmail() {
  const [state, setState] = useState<State>({ k: 'working' });
  // Once per page load, even when React runs the effect twice in development.
  const posted = useRef(false);

  useEffect(() => {
    if (posted.current) return;
    posted.current = true;
    const token = new URLSearchParams(window.location.search).get('t');
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState({ k: 'invalid' });
      return;
    }
    api<{ notification_email: string; store_name: string }>(
      '/v1/settings/notification-email/verify',
      { method: 'POST', json: { token }, store: false },
    )
      .then((r) => setState({ k: 'done', email: r.notification_email, store: r.store_name }))
      .catch((err) =>
        setState(
          err instanceof ApiError && (err.code === 'INVALID_LINK' || err.status === 400)
            ? { k: 'invalid' }
            : { k: 'error', message: errorMessage(err) },
        ),
      );
  }, []);

  if (state.k === 'working') {
    return <Spinner label="Confirming your email" />;
  }
  if (state.k === 'done') {
    return (
      <>
        <p className="login-panel-eyebrow">Notifications</p>
        <h1>Email confirmed</h1>
        <Alert tone="success">
          Payment and refund notices for <strong>{state.store}</strong> now go to{' '}
          <strong>{state.email}</strong>.
        </Alert>
        <p className="login-panel-foot">
          You can change this any time in <Link href={SETTINGS}>Checkout settings</Link>.
        </p>
      </>
    );
  }
  const copy = verifyCopy(state.k);
  return (
    <>
      <p className="login-panel-eyebrow">Notifications</p>
      <h1>{copy.heading}</h1>
      <Alert tone="danger">{state.k === 'invalid' ? copy.message : state.message}</Alert>
      <p className="login-panel-lead">
        Ask for a new link from <Link href={SETTINGS}>Checkout settings</Link> (or from your site’s
        tendr plugin settings).
      </p>
    </>
  );
}
