'use client';

import { useEffect, useMemo, useState } from 'react';
import { DemoButtonLabel } from './DemoButtonLabel';

export type CartPricing = {
  total: string;
  discountOn: boolean;
  discount: number;
};

type Props = {
  busy: boolean;
  onCheckout: (amount: string) => void;
  onPricingChange?: (pricing: CartPricing) => void;
};

const SUBTOTAL = 2199;
const SHIPPING = 9;
const TAX = 5;
const TENDR_CODE = 'tendr';
const TENDR_OFF = 0.25;

const ITEMS = [
  {
    id: 'puffer',
    title: 'Men Top Black Puffed Jacket',
    detail: "Men's Black",
    price: '$999.00',
    qty: 1,
    image: '/demo/puffer-jacket.webp',
    alt: 'Black puffer jacket portrait',
  },
  {
    id: 'beige',
    title: 'Women Jacket',
    detail: 'Women top',
    price: '$1200.00',
    qty: 1,
    image: '/demo/beige-coat.webp',
    alt: 'Beige tailored coat portrait',
  },
] as const;

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

export function EcommerceCart({ busy, onCheckout, onPricingChange }: Props) {
  const [code, setCode] = useState('');
  const [discountOn, setDiscountOn] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const pricing = useMemo(() => {
    const discount = discountOn ? Math.round(SUBTOTAL * TENDR_OFF * 100) / 100 : 0;
    const total = Math.round((SUBTOTAL - discount + SHIPPING + TAX) * 100) / 100;
    return { discount, total };
  }, [discountOn]);

  useEffect(() => {
    onPricingChange?.({
      total: pricing.total.toFixed(2),
      discountOn,
      discount: pricing.discount,
    });
  }, [pricing.total, pricing.discount, discountOn, onPricingChange]);

  function applyCode() {
    const trimmed = code.trim().toLowerCase();
    if (!trimmed) return;
    if (trimmed === TENDR_CODE) {
      setDiscountOn(true);
      setCodeError(null);
      setCode('TENDR');
      return;
    }
    setDiscountOn(false);
    setCodeError('That code isn’t valid in this demo. Try TENDR.');
  }

  function clearDiscount() {
    setDiscountOn(false);
    setCode('');
    setCodeError(null);
  }

  return (
    <div className="demo-cart">
      <div className="demo-cart-heading-row">
        <h3 className="demo-cart-heading">Your Cart</h3>
        {discountOn ? (
          <span className="demo-cart-badge" title="TENDR promo applied">
            25% off
          </span>
        ) : null}
      </div>

      <ul className="demo-cart-items">
        {ITEMS.map((item) => (
          <li key={item.id} className="demo-cart-item">
            <div className="demo-cart-thumb">
              {/* eslint-disable-next-line @next/next/no-img-element -- small static demo thumbnails */}
              <img src={item.image} alt={item.alt} />
              <span className="demo-cart-qty" aria-label={`Quantity ${item.qty}`}>
                {item.qty}
              </span>
            </div>
            <div className="demo-cart-item-copy">
              <p className="demo-cart-item-title">{item.title}</p>
              <p className="demo-cart-item-detail">{item.detail}</p>
            </div>
            <p className="demo-cart-item-price">{item.price}</p>
          </li>
        ))}
      </ul>

      {discountOn ? (
        <div className="demo-cart-applied">
          <span className="demo-cart-badge">TENDR · 25% off</span>
          <button type="button" className="demo-cart-remove-code" onClick={clearDiscount}>
            Remove
          </button>
        </div>
      ) : (
        <div className="demo-cart-discount">
          <span className="demo-cart-discount-icon" aria-hidden>
            %
          </span>
          <input
            type="text"
            placeholder="Discount code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setCodeError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyCode();
              }
            }}
            aria-label="Discount code"
          />
          <button type="button" disabled={!code.trim()} onClick={applyCode}>
            Apply
          </button>
        </div>
      )}
      {codeError ? (
        <p className="demo-cart-code-error" role="alert">
          {codeError}
        </p>
      ) : null}

      <dl className="demo-cart-totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{money(SUBTOTAL)}</dd>
        </div>
        {discountOn ? (
          <div className="demo-cart-discount-line">
            <dt>Discount (TENDR)</dt>
            <dd>−{money(pricing.discount)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Shipping</dt>
          <dd>${SHIPPING}</dd>
        </div>
        <div>
          <dt>
            Estimated taxes
            <span className="demo-cart-help" title="Demo estimate only">
              ?
            </span>
          </dt>
          <dd>{money(TAX)}</dd>
        </div>
        <div className="demo-cart-total">
          <dt>Total</dt>
          <dd>{money(pricing.total)}</dd>
        </div>
      </dl>

      <button
        type="button"
        className="demo-cart-cta"
        disabled={busy}
        aria-busy={busy}
        onClick={() => onCheckout(pricing.total.toFixed(2))}
      >
        <DemoButtonLabel busy={busy} busyLabel="Opening">
          Continue to Payment
        </DemoButtonLabel>
      </button>
    </div>
  );
}
