'use client';

import { Spinner } from '@tendr/ui';

/**
 * Page loading state — centered spinner.
 * `rows` is kept so existing call sites keep compiling.
 */
export function PageSkeleton({
  label = 'Loading',
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="dash-page-spinner" role="status" aria-label={label} aria-busy="true">
      <Spinner label={label} />
    </div>
  );
}

export function OverviewSkeleton() {
  return <PageSkeleton label="Loading overview" />;
}
