import { describe, expect, it, vi } from 'vitest';
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
});
