// The URLs the API hands out for the hosted checkout. They live at the root of the pay host
// (CHECKOUT_BASE_URL): `/{session id}` and `/{merchant}/{link}`. Old `/pay/…` URLs are redirected
// by the web app on the pay host.
import { env } from '../env.js';

function base(): string {
  return env().CHECKOUT_BASE_URL.replace(/\/+$/, '');
}

/** The hosted checkout page of a session, without its `#cs=` fragment. */
export function checkoutUrl(id: string): string {
  return `${base()}/${id}`;
}

/** The public page of a merchant's payment link. */
export function paymentLinkUrl(merchantSlug: string, linkSlug: string): string {
  return `${base()}/${merchantSlug}/${linkSlug}`;
}
