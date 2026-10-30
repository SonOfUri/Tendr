// Trust and selling blocks: trust badges, reviews, FAQ, countdown, delivery note.
import type { ShopperTheme, ThemeLeafBlock } from '@tendr/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { imageUrl } from './assets';

type Of<T extends ThemeLeafBlock['type']> = Extract<ThemeLeafBlock, { type: T }>;

const TENDR_BADGES: Record<
  Extract<Of<'trust_badges'>['badges'][number], { kind: 'tendr' }>['id'],
  string
> = {
  'non-custodial': 'Non-custodial',
  'refund-promise': 'Refund promise',
  'secure-checkout': 'Secure checkout',
  'verified-merchant': 'Verified merchant',
};

export function trustBadges(block: Of<'trust_badges'>, theme: ShopperTheme): ReactNode {
  const items = block.badges.flatMap((badge, i) => {
    if (badge.kind === 'tendr') {
      return [
        <li className="tdr-badge" key={i}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span>{TENDR_BADGES[badge.id]}</span>
        </li>,
      ];
    }
    const src = imageUrl(theme, badge.asset_id);
    if (!src) return [];
    return [
      <li className="tdr-badge" key={i}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Tendr asset origin */}
        <img src={src} alt={badge.alt} loading="lazy" />
      </li>,
    ];
  });
  return items.length ? <ul className="tdr-badges">{items}</ul> : null;
}

export function reviews(block: Of<'reviews'>): ReactNode {
  if (!block.items.length) return null;
  return (
    <ul className="tdr-reviews">
      {block.items.map((r, i) => (
        <li key={i}>
          <figure className="tdr-review">
            {r.rating ? (
              <p className="tdr-rating" aria-label={`${r.rating} out of 5`}>
                {'★'.repeat(r.rating)}
                {'☆'.repeat(5 - r.rating)}
              </p>
            ) : null}
            <blockquote>{r.quote}</blockquote>
            <figcaption>{r.author}</figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}

export function faq(block: Of<'faq'>): ReactNode {
  if (!block.items.length) return null;
  return (
    <div className="tdr-faq">
      {block.items.map((item, i) => (
        <details key={i}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </div>
  );
}

export function deliveryNote(block: Of<'delivery_note'>): ReactNode {
  return <p className="tdr-delivery-note">{block.text}</p>;
}

function remaining(endsAt: number, now: number): string {
  const total = Math.floor((endsAt - now) / 1000);
  if (!(total > 0)) return 'Ended';
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${days > 0 ? `${days}d ` : ''}${h}:${m}:${s}`;
}

/**
 * A merchant's countdown to their own time (a sale, a drop). Styled apart from the payment
 * block's session timer, and its label can't read as a payment deadline (checked on save).
 * The time is filled in after mount so the server and first client render agree.
 */
export function Countdown({ block }: { block: Of<'countdown'> }) {
  const endsAt = Date.parse(block.ends_at);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!(endsAt > t)) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [endsAt]);
  return (
    <p className="tdr-countdown">
      <span className="tdr-countdown-label">{block.label}</span>{' '}
      <span className="tdr-countdown-value">{now === null ? '' : remaining(endsAt, now)}</span>
    </p>
  );
}
