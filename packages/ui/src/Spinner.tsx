export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        border: '2px solid var(--tendr-border)',
        borderTopColor: 'var(--tendr-cyan)',
        animation: 'tendr-spin 0.8s linear infinite',
      }}
    />
  );
}
