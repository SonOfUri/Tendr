'use client';

// The theme's button words (`settings.button_label`, spec §2.1): the visible label of the primary
// pay action in the sealed payment block. The API only accepts words (no digits, currency signs,
// currency codes, or `{…}` other than `{amount}`), and `{amount}` is replaced here with the amount
// Tendr formats — never merchant text. Unset, the button keeps Tendr's own wording.
import { createContext, useContext } from 'react';

/**
 * The theme's button label for the sealed block's primary pay button. Provided around the sealed
 * block only (the checkout's PayFlow → WalletPanel), so it can never label anything else.
 */
export const PayLabelContext = createContext<string | null>(null);

export function usePayLabel(): string | null {
  return useContext(PayLabelContext);
}

/**
 * The pay button's label: the theme's words with `{amount}` filled in, else `fallback`. A label
 * that needs an amount when none is known yet (an open link before one is typed) falls back too.
 */
export function payButtonLabel(
  template: string | null | undefined,
  amount: string | null,
  fallback: string,
): string {
  if (!template) return fallback;
  if (template.includes('{amount}')) {
    if (amount === null) return fallback;
    return template.split('{amount}').join(amount);
  }
  return template;
}
