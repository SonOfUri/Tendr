'use client';
import { NativeWalletPanel } from '@/components/dashboard/NativeWallet';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Alert, Button } from '@tendr/ui';
export default function WalletPage() {
  const { store, me, context, selectStore } = useDashboard();
  if (!store) return null;
  if (!context?.livemode)
    return (
      <section className="card stack">
        <h1>Live wallet</h1>
        <Alert tone="info">
          You are in test mode. Switch to live mode to manage a live wallet.
        </Alert>
        <Button onClick={() => selectStore({ merchantId: store.id, livemode: true })}>
          Switch to live wallet
        </Button>
      </section>
    );
  return (
    <NativeWalletPanel
      key={store.id}
      merchantId={store.id}
      userId={me.user.id}
      isOwner={store.role === 'owner'}
    />
  );
}
