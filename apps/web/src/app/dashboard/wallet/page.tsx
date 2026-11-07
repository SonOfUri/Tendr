'use client';

import { useDashboard } from '@/components/dashboard/DashboardShell';
import { NativeWalletPanel } from '@/components/dashboard/NativeWallet';
import { PageHeader } from '@/components/dashboard/ui';

export default function WalletPage() {
  const { store, me } = useDashboard();
  if (!store) return null;
  return (
    <div className="stack">
      <PageHeader
        title="Wallet"
        description="The live wallet passkey, its settlement token, and withdrawals. This is separate from the passkey you use to sign in."
      />
      <NativeWalletPanel
        merchantId={store.id}
        userId={me.user.id}
        isOwner={store.role === 'owner'}
      />
    </div>
  );
}
