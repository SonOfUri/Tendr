type Props = {
  size?: number;
  className?: string;
  /** Decorative when parent already names Tendr */
  decorative?: boolean;
  /**
   * `white` — mark for dark surfaces (default).
   * `black` — same mark inverted for light surfaces (one source asset).
   */
  tone?: 'white' | 'black';
};

export function TendrLogo({ size = 20, className, decorative = true, tone = 'white' }: Props) {
  const classes = ['tendr-logo', tone === 'black' ? 'tendr-logo--black' : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/tendr-logo.png"
      alt={decorative ? '' : 'Tendr'}
      width={size}
      height={size}
      className={classes}
      decoding="async"
      aria-hidden={decorative || undefined}
    />
  );
}
