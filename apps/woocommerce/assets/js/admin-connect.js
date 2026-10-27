/**
 * tendr settings page: open Connect in a popup and reload once it reports back.
 *
 * The popup starts on this site (admin-post.php), which redirects to usetendr.tech/connect. tendr
 * returns it to this site's callback page, which posts { source: 'tendr-connect' } to this window
 * and closes. A popup closed without reporting back reloads the page too: the callback may have
 * finished (or failed) without being able to tell this window, and the page shows the real state.
 */
(function () {
  'use strict';

  var strings = window.tendrConnect || {};

  document.addEventListener('click', function (event) {
    var disconnect = event.target.closest('[data-tendr-disconnect]');
    if (!disconnect) {
      return;
    }
    // The page puts the confirmation (with the orders still waiting for a payment) on the button.
    var text = disconnect.getAttribute('data-tendr-disconnect') || strings.confirm;
    if (text && !window.confirm(text)) {
      event.preventDefault();
    }
  });

  var button = document.querySelector('[data-tendr-connect]');
  if (!button) {
    return;
  }
  var status = document.querySelector('.tendr-connect-status');

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) {
      return;
    }
    if (!event.data || event.data.source !== 'tendr-connect') {
      return;
    }
    window.location.reload();
  });

  button.addEventListener('click', function () {
    var url = button.getAttribute('data-tendr-connect');
    var width = 520;
    var height = 760;
    var left = Math.max(0, (window.screenX || 0) + (window.outerWidth - width) / 2);
    var top = Math.max(0, (window.screenY || 0) + (window.outerHeight - height) / 2);
    if (status) {
      status.textContent = '';
    }
    var popup = window.open(
      url,
      'tendr-connect',
      'popup=yes,width=' + width + ',height=' + height + ',left=' + left + ',top=' + top,
    );
    if (!popup) {
      // Popup blocked: go through Connect in this tab; the callback page links back here.
      window.location.href = url;
      return;
    }
    popup.focus();
    var timer = window.setInterval(function () {
      if (!popup.closed) {
        return;
      }
      window.clearInterval(timer);
      window.location.reload();
    }, 500);
  });
})();
