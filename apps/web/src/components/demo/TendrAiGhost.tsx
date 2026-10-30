/** Tendr AI ghost mascot — inline so the demo needs no extra asset file. */
export function TendrAiGhost({
  thinking = false,
  size = 40,
}: {
  thinking?: boolean;
  size?: number;
}) {
  return (
    <span
      className="demo-tendrai-ghost"
      data-thinking={thinking ? 'true' : 'false'}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 64 64" width={size} height={size} fill="none">
        <path
          d="M32 6c-12.5 0-22 9.2-22 22.5V48c0 2.2 1.6 3.2 3.2 2.2L20 46.5l5.2 5.2c1.1 1.1 2.9 1.1 4 0L32 48.9l2.8 2.8c1.1 1.1 2.9 1.1 4 0l5.2-5.2 6.8 3.7c1.6 1 3.2 0 3.2-2.2V28.5C54 15.2 44.5 6 32 6Z"
          fill="url(#tendraiGhostBody)"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <circle cx="24.5" cy="28" r="3.2" fill="currentColor" className="demo-tendrai-ghost-eye" />
        <circle cx="39.5" cy="28" r="3.2" fill="currentColor" className="demo-tendrai-ghost-eye" />
        <path
          d="M26 37c2.2 2.4 9.8 2.4 12 0"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          opacity="0.55"
        />
        <defs>
          <linearGradient id="tendraiGhostBody" x1="14" y1="8" x2="48" y2="54" gradientUnits="userSpaceOnUse">
            <stop stopColor="#F4F7FF" />
            <stop offset="1" stopColor="#D7E0F7" />
          </linearGradient>
        </defs>
      </svg>
      {thinking ? (
        <span className="demo-tendrai-ghost-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </span>
  );
}
