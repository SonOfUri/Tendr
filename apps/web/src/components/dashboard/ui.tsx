import type { ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@tendr/ui';

export { Select, type SelectOption } from './Select';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="dash-page-header">
      <div className="dash-page-header-copy">
        <h1 className="dash-page-title">{title}</h1>
        {description ? <p className="dash-page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="dash-page-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  children,
  className = '',
  title,
  action,
  id,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={`dash-panel ${className}`.trim()}>
      {title != null || action != null ? (
        <div className="dash-panel-head">
          {title != null ? <h2 className="dash-panel-title">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="dash-stat">
      <span className="dash-stat-label">
        {icon ? <span className="dash-stat-icon">{icon}</span> : null}
        {label}
      </span>
      <span className="dash-stat-value">{value}</span>
      {hint ? <span className="dash-stat-hint">{hint}</span> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="dash-empty">
      {icon ? <div className="dash-empty-icon">{icon}</div> : null}
      <h3 className="dash-empty-title">{title}</h3>
      {description ? <p className="dash-empty-desc">{description}</p> : null}
      {action ? <div className="dash-empty-action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="dash-error" role="alert">
      <p className="dash-error-msg">{message}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="dash-segment" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="dash-segment-btn"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function FixtureBadge() {
  return (
    <span className="dash-fixture-badge" title="UI preview — not connected to the API yet">
      Preview
    </span>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="dash-text-link">
      {children}
    </Link>
  );
}
