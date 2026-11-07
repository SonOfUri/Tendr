'use client';

// Payout: where a store's payments settle in this mode (choose it here when none is set — the
// plugin's "payout missing" status item, `GET /v1/connect/status`, links here), and the dashboard
// pages that move money out.
import Link from 'next/link';
import { Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useLoad } from '@/components/dashboard/common';
import { PayoutChooser } from '@/components/dashboard/PayoutChooser';
import { ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { api, type AccountView } from '@/lib/api';

export default function PayoutPage() {
  const { store, context } = useDashboard();
  const account = useLoad(
    () => api<AccountView>('/v1/account'),
    context ? `${context.merchantId}:${context.livemode}` : null,
  );
  if (!store || !context) return null;
  if (!account.data) {
    return account.error ? (
      <ErrorState message={account.error} onRetry={() => void account.reload()} />
    ) : (
      <Spinner label="Loading payout settings" />
    );
  }
  const native = account.data.account?.kind === 'native_intents';
  if (native) {
    return (
      <div className="stack">
        <PageHeader
          title="Payout"
          description={`Payments to ${store.name} credit the settlement token inside the live wallet. Withdrawals are signed with the wallet passkey.`}
        />
        <Panel title="Where payments settle">
          <p className="dash-muted">
            Set the default token on the wallet page. A payment link can still choose its own token.
            Neither choice sends funds to an outside address.
          </p>
          <Link href="/dashboard/wallet">Open wallet</Link>
        </Panel>
      </div>
    );
  }
  return (
    <div className="stack">
      <PageHeader
        title="Payout"
        description={
          <>
            Payments to {store.name} settle into its tendr account in your settlement stablecoin.
            Moving money out, or changing where payments settle, is a proposal your signers approve.
          </>
        }
      />
      <Panel title="Where payments settle">
        <PayoutChooser
          key={`${context.merchantId}:${context.livemode}`}
          store={context}
          storeName={store.name}
        />
      </Panel>
      <Panel title="Set up where money goes">
        <ul className="list">
          <li>
            <span className="grow">
              <strong>Saved addresses</strong>
              <br />
              <span className="muted small">
                The wallets money can be paid out to. A new address is usable 24 hours after it is
                approved.
              </span>
            </span>
            <Link href="/dashboard/addresses">Manage saved addresses</Link>
          </li>
          <li>
            <span className="grow">
              <strong>Withdraw</strong>
              <br />
              <span className="muted small">Send your balance to a saved address.</span>
            </span>
            <Link href="/dashboard/withdraw">Withdraw</Link>
          </li>
          <li>
            <span className="grow">
              <strong>Your account</strong>
              <br />
              <span className="muted small">
                Whether this mode&apos;s account is ready to take payments, and going live.
              </span>
            </span>
            <Link href="/dashboard/account">Account status</Link>
          </li>
          <li>
            <span className="grow">
              <strong>Approvals</strong>
              <br />
              <span className="muted small">
                Settlement changes and withdrawals waiting for your signers.
              </span>
            </span>
            <Link href="/dashboard/approvals">Approvals</Link>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
