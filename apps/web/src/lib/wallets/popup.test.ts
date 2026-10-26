import { describe, expect, it, vi } from 'vitest';
import {
  WALLET_DONE,
  isFramed,
  isWalletWindow,
  listenForWalletDone,
  openWalletWindow,
  postWalletDone,
  walletWindowUrl,
  type PopupWindow,
} from './popup';

const SID = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const SECRET = `${SID}_secret_${'0'.repeat(32)}`;
const ORIGIN = 'https://pay.usetendr.tech';
const HASH = '0x' + 'ab'.repeat(32);
const QUOTE_B = 'quo_01JBBBBBBBBBBBBBBBBBBBBBBB';

function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  return {
    location: { origin: ORIGIN, search: '' },
    addEventListener: vi.fn((t: string, fn: (e: MessageEvent) => void) => {
      if (t === 'message') listeners.add(fn);
    }),
    removeEventListener: vi.fn((t: string, fn: (e: MessageEvent) => void) => {
      if (t === 'message') listeners.delete(fn);
    }),
    open: vi.fn(),
    dispatch(e: Partial<MessageEvent>) {
      for (const l of [...listeners]) l(e as MessageEvent);
    },
    listeners,
  };
}

describe('the wallet popup fallback', () => {
  it("opens this checkout's page with ?wallet=1 and the secret in the fragment only", () => {
    expect(walletWindowUrl(ORIGIN, SID, SECRET)).toBe(`${ORIGIN}/pay/${SID}?wallet=1#cs=${SECRET}`);
    const win = fakeWindow();
    const popup = {} as Window;
    win.open.mockReturnValue(popup);
    expect(openWalletWindow(win as unknown as PopupWindow, SID, SECRET)).toBe(popup);
    const [url, name, features] = win.open.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/pay/${SID}?wallet=1#cs=${SECRET}`);
    expect(name).toBe('tendr-wallet');
    expect(features).toMatch(/popup/);
    expect(features).not.toMatch(/noopener/);
  });

  it('a blocked popup returns null', () => {
    const win = fakeWindow();
    win.open.mockReturnValue(null);
    expect(openWalletWindow(win as unknown as PopupWindow, SID, SECRET)).toBeNull();
    win.open.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(openWalletWindow(win as unknown as PopupWindow, SID, SECRET)).toBeNull();
  });

  it("the popup posts only {type, sessionId, txHash, quoteId} to Tendr's own origin", () => {
    const postMessage = vi.fn();
    const win = { location: { origin: ORIGIN }, opener: { postMessage } };
    expect(postWalletDone(win, SID, HASH, QUOTE_B)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      { type: WALLET_DONE, sessionId: SID, txHash: HASH, quoteId: QUOTE_B },
      ORIGIN,
    );
    expect(WALLET_DONE).toBe('tendr:wallet-done');
    expect(postWalletDone({ location: { origin: ORIGIN }, opener: null }, SID, HASH, QUOTE_B)).toBe(
      false,
    );
  });

  it('the opener accepts the message only from its popup, on its own origin', () => {
    const win = fakeWindow();
    const popup = {} as Window;
    const onDone = vi.fn();
    const stop = listenForWalletDone(win as unknown as PopupWindow, popup, SID, onDone);
    const good = { type: WALLET_DONE, sessionId: SID, txHash: HASH, quoteId: QUOTE_B };

    win.dispatch({ origin: 'https://shop.example', source: popup, data: good });
    win.dispatch({ origin: ORIGIN, source: {} as Window, data: good });
    win.dispatch({ origin: ORIGIN, source: popup, data: { ...good, sessionId: 'ses_other' } });
    win.dispatch({ origin: ORIGIN, source: popup, data: { ...good, type: 'tendr:status' } });
    win.dispatch({ origin: ORIGIN, source: popup, data: { ...good, txHash: 'x'.repeat(300) } });
    win.dispatch({ origin: ORIGIN, source: popup, data: { ...good, quoteId: undefined } });
    win.dispatch({ origin: ORIGIN, source: popup, data: { ...good, quoteId: 'not a quote' } });
    win.dispatch({ origin: ORIGIN, source: popup, data: 'tendr:wallet-done' });
    expect(onDone).not.toHaveBeenCalled();

    win.dispatch({ origin: ORIGIN, source: popup, data: good });
    // The popup's own quote (it may have re-quoted), never the opener's.
    expect(onDone).toHaveBeenCalledWith(HASH, QUOTE_B);
    stop();
    expect(win.listeners.size).toBe(0);
  });

  it('detects the wallet window and framing', () => {
    expect(isWalletWindow('?wallet=1')).toBe(true);
    expect(isWalletWindow('?wallet=0')).toBe(false);
    expect(isWalletWindow('')).toBe(false);
    const top = {} as Window;
    expect(isFramed({ self: top, top })).toBe(false);
    expect(isFramed({ self: top, top: {} as Window })).toBe(true);
    expect(
      isFramed({
        self: top,
        get top(): Window {
          throw new Error('cross-origin');
        },
      }),
    ).toBe(true);
  });
});
