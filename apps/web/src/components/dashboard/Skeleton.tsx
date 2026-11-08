'use client';

import type { CSSProperties, ReactNode } from 'react';

/** Soft pulse block for loading placeholders (replaces Spinners on dashboard pages). */
export function Skeleton({
  className = '',
  style,
  label = 'Loading',
}: {
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  return (
    <span
      className={`dash-skel ${className}`.trim()}
      style={style}
      role="status"
      aria-label={label}
      aria-busy="true"
    />
  );
}

export function SkeletonLine({ width = '100%' }: { width?: string | number }) {
  return <Skeleton className="dash-skel-line" style={{ width }} />;
}

export function SkeletonCircle({ size = '2.4rem' }: { size?: string | number }) {
  return <Skeleton className="dash-skel-circle" style={{ width: size, height: size }} />;
}

/** Default page loading layout: header + a couple of panels. */
export function PageSkeleton({
  label = 'Loading',
  rows = 4,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="dash-skel-page" role="status" aria-label={label} aria-busy="true">
      <div className="dash-skel-page-head">
        <SkeletonLine width="12rem" />
        <SkeletonLine width="22rem" />
      </div>
      <div className="dash-skel-page-grid">
        {Array.from({ length: Math.min(3, rows) }, (_, i) => (
          <div key={i} className="dash-skel-card">
            <SkeletonLine width="40%" />
            <SkeletonLine width="70%" />
            <SkeletonLine width="55%" />
          </div>
        ))}
      </div>
      <div className="dash-skel-card dash-skel-card--tall">
        {Array.from({ length: Math.max(3, rows) }, (_, i) => (
          <div key={i} className="dash-skel-row">
            <SkeletonCircle size="1.75rem" />
            <SkeletonLine width={`${58 + ((i * 11) % 28)}%`} />
            <SkeletonLine width="4.5rem" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="dash-skel-page ov" role="status" aria-label="Loading overview" aria-busy="true">
      <div className="dash-skel-ov-hero">
        <div className="dash-skel-card">
          <SkeletonLine width="6rem" />
          <SkeletonLine width="10rem" />
          <SkeletonLine width="8rem" />
        </div>
        <div className="dash-skel-card">
          <SkeletonLine width="7rem" />
          <SkeletonLine width="9rem" />
          <SkeletonLine width="5rem" />
        </div>
        <div className="dash-skel-card dash-skel-card--chart">
          <SkeletonLine width="9rem" />
          <div className="dash-skel-bars">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="dash-skel-bar" style={{ height: `${36 + ((i * 17) % 48)}%` }} />
            ))}
          </div>
        </div>
      </div>
      <div className="dash-skel-card dash-skel-card--tall">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="dash-skel-row">
            <SkeletonCircle />
            <SkeletonLine width={`${50 + i * 6}%`} />
            <SkeletonLine width="5rem" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ShellSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="dash-skel-shell" role="status" aria-label="Loading your dashboard" aria-busy="true">
      {children ?? (
        <>
          <Skeleton className="dash-skel-shell-side" />
          <div className="dash-skel-shell-main">
            <SkeletonLine width="10rem" />
            <PageSkeleton label="Loading your dashboard" />
          </div>
        </>
      )}
    </div>
  );
}
