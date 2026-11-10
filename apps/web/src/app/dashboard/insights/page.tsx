'use client';

import { useDashboard } from '@/components/dashboard/DashboardShell';
import { AiInsightsPanel } from '@/components/dashboard/AiInsightsPanel';
import { PageHeader } from '@/components/dashboard/ui';

export default function InsightsPage() {
  const { store, context } = useDashboard();
  if (!store || !context) return null;

  return (
    <div className="stack">
      <PageHeader
        title="Checkout insights"
        description="Conversion and drop-offs for this store and mode. Tendr AI can explain the same report — it never moves money or changes checkout."
      />
      <AiInsightsPanel merchantId={store.id} livemode={context.livemode} />
    </div>
  );
}
