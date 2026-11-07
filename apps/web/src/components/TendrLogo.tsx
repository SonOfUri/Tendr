type Props = {
  size?: number;
  className?: string;
  /** Decorative when parent already names Tendr */
  decorative?: boolean;
  /**
   * `white` — white geometric mark for dark surfaces.
   * `black` — black geometric mark for light surfaces.
   * Default: `white` for `mark`, `black` for `color` (Powered by).
   */
  tone?: 'white' | 'black';
  /**
   * `mark` — default brand mark.
   * `color` — “Powered by Tendr” (black geometric — never yellow).
   */
  variant?: 'mark' | 'color';
};

export function TendrLogo({
  size = 20,
  className,
  decorative = true,
  tone,
  variant = 'mark',
}: Props) {
  const resolvedTone = tone ?? (variant === 'color' ? 'black' : 'white');
  const classes = [
    'tendr-logo',
    variant === 'color' ? 'tendr-logo--color' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Never `/tendr-logo-mark.png` (yellow). Black or white geometric only.
  const src = resolvedTone === 'black' ? '/tendr-logo-black.png' : '/tendr-logo.png';

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={decorative ? '' : 'Tendr'}
      width={size}
      height={size}
      className={classes}
      decoding="async"
      aria-hidden={decorative || undefined}
    />
  );
}
