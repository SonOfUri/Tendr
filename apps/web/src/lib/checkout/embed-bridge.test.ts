import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbedBridge, type BridgeWindow } from './embed-bridge';

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const SHOP = 'https://shop.example';

function framedWindow(referrer: string) {
  const postMessage = vi.fn();
  const win = { document: { referrer }, parent: { postMessage } } as unknown as BridgeWindow;
  return { win, postMessage };
}

describe('embed bridge', () => {
  it('posts to the framing origin when it is one of the checkout domains', () => {
    const { win, postMessage } = framedWindow('https://shop.example/checkout?step=2');
    const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
    expect(bridge.framed).toBe(true);
    expect(bridge.targetOrigin).toBe(SHOP);
    bridge.ready('pending');
    bridge.status('detected');
    bridge.status('settled');
    bridge.close();
    expect(postMessage.mock.calls).toEqual([
      [{ type: 'tendr:ready', sessionId: SESSION, status: 'pending' }, SHOP],
      [{ type: 'tendr:status', sessionId: SESSION, status: 'detected' }, SHOP],
      [{ type: 'tendr:status', sessionId: SESSION, status: 'settled' }, SHOP],
      [{ type: 'tendr:complete', sessionId: SESSION, status: 'settled' }, SHOP],
      [{ type: 'tendr:close', sessionId: SESSION, status: 'settled' }, SHOP],
    ]);
  });

  it('never posts to "*", and only {type, sessionId, status}', () => {
    const { win, postMessage } = framedWindow(`${SHOP}/`);
    const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
    bridge.ready('pending');
    bridge.status('converting');
    bridge.close();
    expect(postMessage).toHaveBeenCalledTimes(3);
    for (const [msg, origin] of postMessage.mock.calls) {
      expect(origin).toBe(SHOP);
      expect(Object.keys(msg as object).sort()).toEqual(['sessionId', 'status', 'type']);
    }
  });

  it('posts nothing when the framing origin is not a checkout domain', () => {
    for (const referrer of [
      'https://evil.example/',
      'https://shop.example.evil.example/',
      'http://shop.example/', // scheme differs
      'https://shop.example:8443/', // port differs
      '', // no referrer
      'not a url',
    ]) {
      const { win, postMessage } = framedWindow(referrer);
      const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
      expect(bridge.targetOrigin).toBeNull();
      bridge.ready('pending');
      bridge.status('settled');
      bridge.close();
      expect(postMessage).not.toHaveBeenCalled();
    }
  });

  it('posts nothing when there are no checkout domains', () => {
    const { win, postMessage } = framedWindow(`${SHOP}/`);
    const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [] });
    bridge.ready('pending');
    bridge.close();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts nothing when not framed (the hosted page)', () => {
    const postMessage = vi.fn();
    const self: Record<string, unknown> = { document: { referrer: `${SHOP}/` }, postMessage };
    self.parent = self;
    const win = self as unknown as BridgeWindow;
    const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
    expect(bridge.framed).toBe(false);
    expect(bridge.targetOrigin).toBeNull();
    bridge.ready('pending');
    bridge.status('settled');
    bridge.close();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sends a status only when it changes, and complete once', () => {
    const { win, postMessage } = framedWindow(`${SHOP}/`);
    const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
    bridge.status('converting');
    bridge.status('converting');
    bridge.status('settled');
    bridge.status('settled');
    const types = postMessage.mock.calls.map(([m]) => (m as { type: string }).type);
    expect(types).toEqual(['tendr:status', 'tendr:status', 'tendr:complete']);
  });

  it('survives a parent whose postMessage throws', () => {
    const win = {
      document: { referrer: `${SHOP}/` },
      parent: {
        postMessage: () => {
          throw new Error('detached');
        },
      },
    } as unknown as BridgeWindow;
    const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
    expect(() => bridge.ready('pending')).not.toThrow();
  });

  describe('resize', () => {
    /** A framed window with a fake ResizeObserver; timers are vi's fake timers. */
    function resizable(referrer = `${SHOP}/`) {
      const postMessage = vi.fn();
      const observers: { cb: () => void; observed: unknown[]; disconnected: boolean }[] = [];
      class FakeResizeObserver {
        entry: (typeof observers)[number];
        constructor(cb: () => void) {
          this.entry = { cb, observed: [], disconnected: false };
          observers.push(this.entry);
        }
        observe(el: unknown) {
          this.entry.observed.push(el);
        }
        disconnect() {
          this.entry.disconnected = true;
        }
      }
      const win = {
        document: { referrer },
        parent: { postMessage },
        ResizeObserver: FakeResizeObserver,
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      } as unknown as BridgeWindow;
      let height = 400;
      const el = { getBoundingClientRect: () => ({ height }) };
      const setHeight = (h: number) => {
        height = h;
        for (const o of observers) if (!o.disconnected) o.cb();
      };
      return { win, postMessage, observers, el, setHeight };
    }
    const resizes = (postMessage: ReturnType<typeof vi.fn>) =>
      postMessage.mock.calls.filter(([m]) => (m as { type: string }).type === 'tendr:resize');

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('posts the page height to the framing origin, at once and then throttled', () => {
      const { win, postMessage, el, setHeight } = resizable();
      const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
      bridge.watchHeight(el);
      expect(postMessage.mock.calls).toEqual([
        [{ type: 'tendr:resize', sessionId: SESSION, height: 400 }, SHOP],
      ]);
      setHeight(410.2);
      setHeight(420);
      setHeight(430);
      expect(resizes(postMessage)).toHaveLength(1);
      vi.advanceTimersByTime(150);
      // One trailing post, with the latest height.
      expect(resizes(postMessage).slice(1)).toEqual([
        [{ type: 'tendr:resize', sessionId: SESSION, height: 430 }, SHOP],
      ]);
      // An unchanged height is not posted again.
      setHeight(430);
      vi.advanceTimersByTime(500);
      expect(resizes(postMessage)).toHaveLength(2);
      // Heights are rounded up, so the frame never clips.
      setHeight(300.5);
      vi.advanceTimersByTime(500);
      expect(resizes(postMessage).at(-1)).toEqual([
        { type: 'tendr:resize', sessionId: SESSION, height: 301 },
        SHOP,
      ]);
    });

    it('sends only {type, sessionId, height}, never to "*"', () => {
      const { win, postMessage, el } = resizable();
      createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] }).watchHeight(el);
      expect(postMessage).toHaveBeenCalledTimes(1);
      for (const [msg, origin] of postMessage.mock.calls) {
        expect(origin).toBe(SHOP);
        expect(Object.keys(msg as object).sort()).toEqual(['height', 'sessionId', 'type']);
      }
    });

    it('does nothing when the framing origin is not a checkout domain', () => {
      const { win, postMessage, observers, el, setHeight } = resizable('https://evil.example/');
      const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
      const stop = bridge.watchHeight(el);
      setHeight(900);
      vi.advanceTimersByTime(500);
      expect(postMessage).not.toHaveBeenCalled();
      expect(observers).toHaveLength(0);
      expect(() => stop()).not.toThrow();
    });

    it('stops observing when stopped', () => {
      const { win, postMessage, observers, el, setHeight } = resizable();
      const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
      const stop = bridge.watchHeight(el);
      setHeight(500);
      stop();
      expect(observers[0]!.disconnected).toBe(true);
      // A pending trailing post is dropped too.
      vi.advanceTimersByTime(500);
      setHeight(999);
      vi.advanceTimersByTime(500);
      expect(resizes(postMessage)).toHaveLength(1);
    });

    it('is a no-op without ResizeObserver', () => {
      const postMessage = vi.fn();
      const win = {
        document: { referrer: `${SHOP}/` },
        parent: { postMessage },
      } as unknown as BridgeWindow;
      const el = { getBoundingClientRect: () => ({ height: 10 }) };
      const bridge = createEmbedBridge({ win, sessionId: SESSION, checkoutDomains: [SHOP] });
      const stop = bridge.watchHeight(el);
      expect(postMessage).not.toHaveBeenCalled();
      expect(() => stop()).not.toThrow();
    });
  });
});
