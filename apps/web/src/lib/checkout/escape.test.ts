import { describe, expect, it } from 'vitest';
import { isModalEmbed, shouldForwardEscape } from './escape';

const doc = (openSelector: string | null = null) => ({
  querySelector: (s: string) => (openSelector !== null && s.includes(openSelector) ? {} : null),
});
const key = (over: Partial<Parameters<typeof shouldForwardEscape>[0]> = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  target: { closest: () => null },
  ...over,
});
const modal = { modal: true, walletModalOpen: false, doc: doc() };

describe('isModalEmbed', () => {
  it('only for ?embed=modal', () => {
    expect(isModalEmbed('?embed=modal')).toBe(true);
    expect(isModalEmbed('?x=1&embed=modal')).toBe(true);
    expect(isModalEmbed('')).toBe(false);
    expect(isModalEmbed('?embed=widget')).toBe(false);
    expect(isModalEmbed('?wallet=1')).toBe(false);
  });
});

describe('shouldForwardEscape', () => {
  it('forwards a plain Esc in the modal', () => {
    expect(shouldForwardEscape(key(), modal)).toBe(true);
  });

  it('never in the widget or the hosted page', () => {
    expect(shouldForwardEscape(key(), { ...modal, modal: false })).toBe(false);
  });

  it('only Escape', () => {
    expect(shouldForwardEscape(key({ key: 'Enter' }), modal)).toBe(false);
  });

  it('not when something already handled it', () => {
    expect(shouldForwardEscape(key({ defaultPrevented: true }), modal)).toBe(false);
  });

  it('not while a wallet modal is open', () => {
    expect(shouldForwardEscape(key(), { ...modal, walletModalOpen: true })).toBe(false);
    expect(shouldForwardEscape(key(), { ...modal, doc: doc('[aria-modal="true"]') })).toBe(false);
    expect(shouldForwardEscape(key(), { ...modal, doc: doc('dialog[open]') })).toBe(false);
  });

  it('not from a select', () => {
    const inSelect = key({ target: { closest: (s: string) => (s === 'select' ? {} : null) } });
    expect(shouldForwardEscape(inSelect, modal)).toBe(false);
  });
});
