import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../assets/js/checkout.js', import.meta.url), 'utf8');
const sessionUrl = 'https://pay.usetendr.tech/ses_example#cs=secret';
const successUrl = 'https://shop.example/order-received/74';

function checkout(sdk = 'normal') {
  const timers = new Map();
  const redirects = [];
  const opens = [];
  let timerId = 0;
  let click;
  let closes = 0;
  const button = { addEventListener: (_, fn) => (click = fn), focus() {} };
  const window = {
    tendrCheckout: { action: 'pay', sessionUrl, successUrl },
    location: { assign: (url) => redirects.push(url) },
    setTimeout: (fn, ms) => {
      assert.equal(ms, 15000);
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    Tendr:
      sdk === 'missing'
        ? undefined
        : {
            open(opts) {
              if (sdk === 'throws') throw new Error('SDK unavailable');
              opens.push(opts);
              return {
                close() {
                  closes++;
                  opts.onEvent({ type: 'close' });
                },
              };
            },
          },
  };
  const document = {
    readyState: 'complete',
    querySelector: () => ({ querySelector: () => button }),
  };
  runInNewContext(source, { window, document });
  return {
    redirects,
    opens,
    timers,
    closes: () => closes,
    tick() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    reopen() {
      click({ preventDefault() {} });
    },
  };
}

test('a blocked or failed frame falls back to the exact same hosted session', () => {
  const c = checkout();
  assert.equal(c.opens[0].sessionUrl, sessionUrl);
  assert.deepEqual(c.redirects, []);
  c.tick();
  assert.equal(c.closes(), 1);
  assert.deepEqual(c.redirects, [sessionUrl]);
  c.opens[0].onEvent({ type: 'complete' });
  assert.deepEqual(c.redirects, [sessionUrl], 'ignore late events from the discarded frame');
});

test('a ready checkout is never redirected while the shopper is paying', () => {
  const c = checkout();
  c.opens[0].onEvent({ type: 'ready' });
  assert.equal(c.timers.size, 0);
  c.tick();
  assert.deepEqual(c.redirects, []);
  c.opens[0].onEvent({ type: 'complete' });
  assert.deepEqual(c.redirects, [successUrl]);
});

test('closing cancels fallback; reopening ignores the old frame and gets a new timeout', () => {
  const c = checkout();
  c.opens[0].onEvent({ type: 'close' });
  c.tick();
  assert.deepEqual(c.redirects, []);
  c.reopen();
  c.opens[0].onEvent({ type: 'ready' });
  c.opens[0].onEvent({ type: 'complete' });
  assert.equal(c.timers.size, 1);
  c.tick();
  assert.deepEqual(c.redirects, [sessionUrl]);
});

test('completion before ready cancels fallback and goes only to order confirmation', () => {
  const c = checkout();
  c.opens[0].onEvent({ type: 'complete' });
  c.tick();
  assert.deepEqual(c.redirects, [successUrl]);
});

for (const sdk of ['missing', 'throws']) {
  test(`${sdk} SDK falls back immediately without leaving a redirect timer`, () => {
    const c = checkout(sdk);
    assert.equal(c.timers.size, 0);
    c.tick();
    assert.deepEqual(c.redirects, [sessionUrl]);
  });
}
