import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { checkoutUrl, paymentLinkUrl } from './urls.js';

const saved = process.env.CHECKOUT_BASE_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.CHECKOUT_BASE_URL;
  else process.env.CHECKOUT_BASE_URL = saved;
  loadEnv();
});

describe('checkout URL builders', () => {
  it('builds the root-form session URL, stripping a trailing slash', () => {
    process.env.CHECKOUT_BASE_URL = 'https://pay.usetendr.tech/';
    loadEnv();
    expect(checkoutUrl('ses_1')).toBe('https://pay.usetendr.tech/ses_1');
  });

  it('builds the root-form payment link URL', () => {
    process.env.CHECKOUT_BASE_URL = 'https://pay.usetendr.tech';
    loadEnv();
    expect(paymentLinkUrl('acme', 'coffee')).toBe('https://pay.usetendr.tech/acme/coffee');
  });
});
