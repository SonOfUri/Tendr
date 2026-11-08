import type { ReactNode } from 'react';

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) {
  const border =
    tone === 'warning'
      ? 'var(--tendr-warning)'
      : tone === 'danger'
        ? 'var(--tendr-danger)'
        : tone === 'success'
          ? 'var(--tendr-success)'
          : 'var(--tendr-cyan)';

  return (
    <div
      role="status"
      style={{
        borderLeft: `3px solid ${border}`,
        background: 'rgba(15, 22, 41, 0.85)',
        padding: '0.85rem 1rem',
        // Round only the free corners. A full radius bends the left border into a
        // crescent — ugly when themes map success/warning to near-white (dashboard).
        borderRadius: '0 var(--tendr-radius) var(--tendr-radius) 0',
        color: 'var(--tendr-white)',
        fontSize: '0.95rem',
      }}
    >
      {children}
    </div>
  );
}
