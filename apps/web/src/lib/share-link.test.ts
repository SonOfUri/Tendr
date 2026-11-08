import { afterEach, describe, expect, it, vi } from 'vitest';
import { canNativeShare, copyToClipboard, sharePaymentLink } from './share-link';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sharePaymentLink', () => {
  it('uses the device share sheet on coarse pointers', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, media: '(pointer: coarse)' }),
    );
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

  it('copies on desktop even when share exists', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, media: '(pointer: coarse)' }),
    );
    let shared = false;
    let copied = '';
    const result = await sharePaymentLink('https://pay.usetendr.tech/bez/spring', 'Spring invoice', {
      share: async () => {
        shared = true;
      },
      clipboard: {
        writeText: async (text) => {
          copied = text;
        },
      },
    });
    expect(result).toBe('copied');
    expect(shared).toBe(false);
    expect(copied).toBe('https://pay.usetendr.tech/bez/spring');
  });

  it('leaves the link alone when the person closes the share sheet', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, media: '(pointer: coarse)' }),
    );
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
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, media: '(pointer: coarse)' }),
    );
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

  it('falls back to clipboard when share throws a non-abort error', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, media: '(pointer: coarse)' }),
    );
    let copied = '';
    const result = await sharePaymentLink('https://pay.usetendr.tech/bez/spring', 'Spring invoice', {
      share: async () => {
        throw new DOMException('Denied', 'NotAllowedError');
      },
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

describe('copyToClipboard', () => {
  it('returns false when nothing can copy', async () => {
    expect(await copyToClipboard('x', {})).toBe(false);
  });
});

describe('canNativeShare', () => {
  it('is false on fine pointers even if share exists', () => {
    vi.stubGlobal('navigator', { share: async () => undefined });
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, media: '(pointer: coarse)' }),
    );
    expect(canNativeShare()).toBe(false);
  });
});
