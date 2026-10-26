// The checkout's boot script: served as /checkout-boot.js (app/checkout-boot.js/route.ts) and
// loaded by a parser-blocking <script src> in the root layout's <head> on checkout pages
// (components/CheckoutBootScript.tsx), so it runs while the document is parsed, before the first
// RSC chunk and before Next hydrates. Next builds
// its router's canonicalUrl (and the tree it writes into history.state) from `location` at
// hydration; if `#cs=…` were still there it would live on in history.state and come back on any
// router update. So the script moves the secret out of the URL first:
//
// - `/pay/<session id>` only, and only when the fragment carries `cs`;
// - the whole fragment is dropped with history.replaceState (null state: Next has not written
//   its own yet);
// - a well-formed secret for this session goes to sessionStorage (`tendr:cs:<id>`, overwriting a
//   stale value: the fragment wins) and to a hidden, non-enumerable window property that
//   takeClientSecret reads once and deletes (the handoff when storage is blocked);
// - everything is in try/catch: a failure leaves the page to the fallback in secret.ts.
//
// It is a plain ES5 string so it runs as written (no bundler transforms).

/** Where the boot script is served (same origin, so CSP `script-src 'self'` allows it). */
export const CHECKOUT_BOOT_SCRIPT_PATH = '/checkout-boot.js';

/** The non-enumerable window property the boot script hands the secret over on. */
export const SECRET_HANDOFF = '__tendrCheckoutSecret';

export const CHECKOUT_BOOT_SCRIPT = `(function (w) {
  try {
    var m = /^\\/pay\\/(ses_[0-9A-HJKMNP-TV-Z]{26})\\/?$/.exec(w.location.pathname);
    var hash = w.location.hash || '';
    if (!m || hash.length < 2) return;
    var cs = new URLSearchParams(hash.slice(1)).get('cs');
    if (cs === null) return;
    w.history.replaceState(null, '', w.location.pathname + w.location.search);
    var re = /^(ses_[0-9A-HJKMNP-TV-Z]{26})_secret_[0-9a-f]{32}$/;
    var ok = re.exec(cs);
    if (!ok || ok[1] !== m[1]) return;
    try { w.sessionStorage.setItem('tendr:cs:' + m[1], cs); } catch (e) {}
    Object.defineProperty(w, '${SECRET_HANDOFF}', {
      value: { sessionId: m[1], secret: cs },
      configurable: true,
      enumerable: false,
      writable: false
    });
  } catch (e) {}
})(window);`;
