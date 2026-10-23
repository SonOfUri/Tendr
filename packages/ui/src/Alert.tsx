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
        borderRadius: 'var(--tendr-radius)',
        color: 'var(--tendr-white)',
        fontSize: '0.95rem',
      }}
    >
      {children}
    </div>
  );
}
