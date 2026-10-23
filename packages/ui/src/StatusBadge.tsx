import type { CSSProperties } from 'react';

const palette: Record<string, { bg: string; color: string }> = {
  CREATED: { bg: 'rgba(201,198,255,0.15)', color: 'var(--tendr-lavender)' },
  AWAITING_PAYMENT: { bg: 'rgba(22,199,247,0.15)', color: 'var(--tendr-cyan)' },
  PROCESSING: { bg: 'rgba(245,185,66,0.18)', color: 'var(--tendr-warning)' },
  SETTLED: { bg: 'rgba(45,212,168,0.18)', color: 'var(--tendr-success)' },
  EXPIRED: { bg: 'rgba(139,147,167,0.2)', color: 'var(--tendr-muted)' },
  FAILED: { bg: 'rgba(255,92,122,0.18)', color: 'var(--tendr-danger)' },
  REFUND_PENDING: { bg: 'rgba(245,185,66,0.18)', color: 'var(--tendr-warning)' },
  REFUNDED: { bg: 'rgba(139,147,167,0.2)', color: 'var(--tendr-muted)' },
  sandbox: { bg: 'rgba(22,199,247,0.12)', color: 'var(--tendr-cyan)' },
};

export function StatusBadge({ status }: { status: string }) {
  const colors = palette[status] ?? palette.CREATED!;
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    padding: '0.25rem 0.65rem',
    borderRadius: 999,
    background: colors.bg,
    color: colors.color,
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
  };
  return <span style={style}>{status.replaceAll('_', ' ')}</span>;
}
