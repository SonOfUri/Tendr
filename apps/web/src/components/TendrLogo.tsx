type Props = {
  size?: number;
  className?: string;
  /** Decorative when parent already names Tendr */
  decorative?: boolean;
};

export function TendrLogo({ size = 20, className, decorative = true }: Props) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/tendr-logo.png"
      alt={decorative ? '' : 'Tendr'}
      width={size}
      height={size}
      className={className ? `tendr-logo ${className}` : 'tendr-logo'}
      decoding="async"
      aria-hidden={decorative || undefined}
    />
  );
}
