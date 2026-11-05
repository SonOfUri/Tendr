'use client';

// Payout: where a store's payments settle in this mode (choose it here when none is set — the
// plugin's "payout missing" status item, `GET /v1/connect/status`, links here), and the dashboard
// pages that move money out.
import Link from 'next/link';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { PayoutChooser } from '@/components/dashboard/PayoutChooser';
import { PageHeader, Panel } from '@/components/dashboard/ui';

export default function PayoutPage() {
  const { store, context } = useDashboard();
  if (!store || !context) return null;
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
            <Link href="/dashboard">Account status</Link>
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
