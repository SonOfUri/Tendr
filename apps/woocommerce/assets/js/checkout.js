/**
 * tendr checkout, on two WooCommerce pages (data in window.tendrCheckout):
 *
 * - action "pay" (the order-pay step): open the tendr modal (tendr.js, `Tendr.open({ sessionUrl,
 *   onEvent })`) on the order's session. When the checkout completes, go to the thank-you page.
 *   If the modal can't run (tendr.js blocked or failed to load, an old browser, or it refuses the
 *   URL), go to the hosted checkout page instead.
 * - action "wait" (the thank-you page): ask the plugin's order-status endpoint every few seconds
 *   and reload once the order is no longer pending. The browser never marks an order paid; the
 *   signed webhook does.
 */
(function () {
  'use strict';

  var data = window.tendrCheckout;
  if (!data || typeof data !== 'object') return;

  function pay() {
    var root = document.querySelector('[data-tendr-pay]');
    var button = root ? root.querySelector('[data-tendr-open]') : null;
    var opened = false;

    function redirect() {
      window.location.assign(data.sessionUrl);
    }

    function onEvent(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'complete') {
        window.location.assign(data.successUrl);
      } else if (event.type === 'close') {
        opened = false;
        if (button) button.focus();
      }
    }

    function open() {
      if (opened) return;
      var tendr = window.Tendr;
      if (!tendr || typeof tendr.open !== 'function') {
        redirect();
        return;
      }
      try {
        tendr.open({ sessionUrl: data.sessionUrl, onEvent: onEvent });
        opened = true;
      } catch (e) {
        redirect();
      }
    }

    if (button) {
      button.addEventListener('click', function (e) {
        e.preventDefault();
        open();
      });
    }
    open();
  }

  function wait() {
    var interval = typeof data.interval === 'number' && data.interval > 0 ? data.interval : 3000;
    var stopAfter =
      typeof data.stopAfter === 'number' && data.stopAfter > 0 ? data.stopAfter : 60 * 60 * 1000;
    var stopAt = Date.now() + stopAfter;

    function stop() {
      var el = document.querySelector('[data-tendr-waiting]');
      if (el && typeof data.slowText === 'string') el.textContent = data.slowText;
    }

    function poll() {
      if (Date.now() > stopAt) {
        stop();
        return;
      }
      if (!window.fetch) return;
      window
        .fetch(data.statusUrl, {
          credentials: 'omit',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (body) {
          if (body && typeof body.status === 'string' && body.status !== 'pending') {
            window.location.reload();
            return;
          }
          window.setTimeout(poll, interval);
        })
        .catch(function () {
          window.setTimeout(poll, interval);
        });
    }

    window.setTimeout(poll, interval);
  }

  function start() {
    if (data.action === 'pay' && typeof data.sessionUrl === 'string') pay();
    else if (data.action === 'wait' && typeof data.statusUrl === 'string') wait();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
