import { TendrLogo } from '@/components/TendrLogo';

type Props = {
  busy?: boolean;
  /** Shown with the spinner while busy (defaults to the idle label). */
  busyLabel?: string;
  /** Show the Tendr mark before the label (e.g. Pay with Tendr). */
  withLogo?: boolean;
  children: string;
};

/** Idle label; when busy: spinner + busyLabel (or the same label). */
export function DemoButtonLabel({ busy, busyLabel, withLogo, children }: Props) {
  const label = busy ? (busyLabel ?? children) : children;
  return (
    <span className="demo-btn-label">
      {busy ? <span className="demo-spinner" aria-hidden /> : null}
      {!busy && withLogo ? <TendrLogo size={18} className="demo-btn-logo" /> : null}
      <span>{label}</span>
    </span>
  );
}
