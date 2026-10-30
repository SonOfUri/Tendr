// The order summary block's content on the checkout: the cart's lines (image, name, quantity,
// amount) and, when they don't add up to the session amount, a "Shipping, tax or discounts"
// line for the difference. Amounts use integer arithmetic on decimal strings, never floats.
import type { SessionLineItem } from '@/lib/checkout/api';
import { formatOrderAmount, safeHttpUrl } from '@/lib/checkout/format';

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** A decimal string as an integer of `scale` decimal places, or null when malformed. */
function scaled(amount: string, scale: number): bigint | null {
  const m = DECIMAL.exec(amount.trim());
  if (!m || (m[2] ?? '').length > scale) return null;
  return BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt((m[2] ?? '').padEnd(scale, '0') || '0');
}

function decimals(amount: string): number {
  return DECIMAL.exec(amount.trim())?.[2]?.length ?? 0;
}

/** An integer of `scale` decimal places back to a decimal string ("25.10"). */
function unscaled(value: bigint, scale: number): string {
  const neg = value < 0n;
  const digits = (neg ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale ? `.${digits.slice(digits.length - scale)}` : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
}

export interface OrderLinesMath {
  lines: { item: SessionLineItem; total: string }[];
  /** `amount − Σ lines`, or null when they match (or an amount is malformed). */
  difference: string | null;
}

/** Each line's total and the difference to the session amount. */
export function orderLinesMath(items: readonly SessionLineItem[], amount: string): OrderLinesMath {
  const scale = Math.max(2, decimals(amount), ...items.map((i) => decimals(i.unit_amount)));
  let sum = 0n;
  let ok = scaled(amount, scale) !== null;
  const lines = items.map((item) => {
    const unit = scaled(item.unit_amount, scale);
    if (unit === null) {
      ok = false;
      return { item, total: item.unit_amount };
    }
    const total = unit * BigInt(item.quantity);
    sum += total;
    return { item, total: unscaled(total, scale) };
  });
  const diff = ok ? scaled(amount, scale)! - sum : 0n;
  return { lines, difference: diff === 0n ? null : unscaled(diff, scale) };
}

export function OrderLines({
  items,
  amount,
  currency,
  symbol,
  format,
}: {
  items: readonly SessionLineItem[];
  amount: string;
  currency: string;
  /** The settlement token's symbol when the amount isn't in USD (as the order total shows it). */
  symbol: string | null;
  /** Writes a non-negative amount; default as the order total (`formatOrderAmount`). */
  format?: (amount: string) => string;
}) {
  const { lines, difference } = orderLinesMath(items, amount);
  const write = format ?? ((v: string) => formatOrderAmount(v, currency, symbol));
  const money = (v: string) => (v.startsWith('-') ? `−${write(v.slice(1))}` : write(v));
  return (
    <div className="tdr-lines">
      <ul className="tdr-lines-list">
        {lines.map(({ item, total }, i) => {
          const image = safeHttpUrl(item.image_url);
          return (
            <li key={i} className="tdr-line">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element -- Tendr's cached product image
                <img className="tdr-line-image" src={image} alt="" width={48} height={48} />
              ) : null}
              <span className="tdr-line-name">
                {item.name}
                <span className="tdr-line-qty"> × {item.quantity}</span>
              </span>
              <span className="tdr-line-amount">{money(total)}</span>
            </li>
          );
        })}
        {difference ? (
          <li className="tdr-line tdr-line-adjust">
            <span className="tdr-line-name">Shipping, tax or discounts</span>
            <span className="tdr-line-amount">{money(difference)}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
