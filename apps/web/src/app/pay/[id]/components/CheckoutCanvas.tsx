'use client';

// The checkout drawn on the theme's canvas. What the merchant's blocks surround depends on the
// screen:
// - pay: the theme's page (`blocks`), the sealed payment block in its place, the cart in the
//   order summary block, and the phone pay bar;
// - complete: the payment status (sealed) above the theme's thank-you page (`success_blocks`),
//   with the theme's message, back-to-store link and celebration;
// - every other status screen (expired, held, refunded…): Tendr's wording in the sealed block
//   under the theme's header only — styled by the theme, nothing else of it.
import type { ShopperTheme, ThemeBlock } from '@tendr/contracts';
import type { ReactNode } from 'react';
import { BlockCanvas } from '@/components/theme/BlockCanvas';
import { Celebration } from '@/components/theme/Celebration';
import { WithPayBar } from '@/components/theme/PayBar';
import type { SessionView } from '@/lib/checkout/api';
import type { ScreenKind } from '@/lib/checkout/status';
import { OrderLines } from './OrderLines';
import { BackLink } from './StatusScreens';

/** What the thank-you block says when the theme sets no message. */
export const DEFAULT_SUCCESS_MESSAGE = 'Payment received — thank you.';

/** Where the payment status sits on the thank-you page: first, above the theme's blocks. */
const STATUS_BLOCK: ThemeBlock = { id: 'tdr-status', type: 'payment' };

/** The theme's visible back-to-store block, if its thank-you page has one. */
export function successBackBlock(
  theme: ShopperTheme,
): Extract<ThemeBlock, { type: 'back_to_store' }> | null {
  const b = theme.document.success_blocks.find((x) => x.type === 'back_to_store' && !x.hidden);
  return b?.type === 'back_to_store' ? b : null;
}

export function CheckoutCanvas({
  view,
  theme,
  screen,
  sealed,
  amountText,
  settlementSymbol = null,
  formatAmount,
}: {
  view: SessionView;
  theme: ShopperTheme;
  screen: ScreenKind;
  /** The sealed payment block's content for this screen. */
  sealed: ReactNode;
  /** The order total as the sealed block shows it (the pay bar repeats it). */
  amountText: string;
  settlementSymbol?: string | null;
  /** How cart amounts are written (the preview's sample currency); default as the order total. */
  formatAmount?: (amount: string) => string;
}) {
  const settings = theme.document.settings;

  let canvas: ReactNode;
  if (screen === 'pay') {
    const items = Array.isArray(view.line_items) ? view.line_items : [];
    canvas = (
      <BlockCanvas
        blocks={theme.document.blocks}
        theme={theme}
        slots={{
          payment: sealed,
          orderSummary: items.length ? (
            <OrderLines
              items={items}
              amount={view.amount}
              currency={view.amount_currency}
              symbol={settlementSymbol}
              format={formatAmount}
            />
          ) : undefined,
        }}
      />
    );
  } else if (screen === 'complete') {
    const back = successBackBlock(theme);
    canvas = (
      <BlockCanvas
        blocks={[STATUS_BLOCK, ...theme.document.success_blocks]}
        theme={theme}
        slots={{
          payment: sealed,
          thankYou: (
            <p className="tdr-thank-you">{settings.success_message || DEFAULT_SUCCESS_MESSAGE}</p>
          ),
          backToStore: back ? <BackLink view={view} to="success" label={back.label} /> : null,
        }}
      />
    );
  } else {
    canvas = (
      <BlockCanvas
        blocks={theme.document.blocks.filter((b) => b.type === 'header')}
        theme={theme}
        slots={{ payment: sealed }}
      />
    );
  }

  return (
    <WithPayBar amount={amountText} payee={view.merchant.name} enabled={screen === 'pay'}>
      {canvas}
      {screen === 'complete' ? <Celebration kind={settings.celebration} /> : null}
    </WithPayBar>
  );
}
