import { describe, expect, it } from 'vitest';
import { sharePaymentLink } from './share-link';

describe('sharePaymentLink', () => {
  it('uses the device share sheet when the browser has one', async () => {
    let shared = '';
    const result = await sharePaymentLink('https://pay.usetendr.tech/bez/spring', 'Spring invoice', {
      share: async (data) => {
        shared = data.url ?? '';
      },
      clipboard: { writeText: async () => undefined },
    });
    expect(result).toBe('shared');
    expect(shared).toBe('https://pay.usetendr.tech/bez/spring');
  });

  it('leaves the link alone when the person closes the share sheet', async () => {
    let copied = false;
    const result = await sharePaymentLink('https://pay.usetendr.tech/bez/spring', 'Spring invoice', {
      share: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
      clipboard: {
        writeText: async () => {
          copied = true;
        },
      },
    });
    expect(result).toBe('cancelled');
    expect(copied).toBe(false);
  });

  it('copies the URL when the device has no share sheet', async () => {
    let copied = '';
    const result = await sharePaymentLink('https://pay.usetendr.tech/bez/spring', 'Spring invoice', {
      clipboard: {
        writeText: async (text) => {
          copied = text;
        },
      },
    });
    expect(result).toBe('copied');
    expect(copied).toBe('https://pay.usetendr.tech/bez/spring');
  });
});
