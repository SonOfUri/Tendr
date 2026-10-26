/**
 * tendr settings page: open Connect in a popup and reload once it reports back.
 *
 * The popup starts on this site (admin-post.php), which redirects to usetendr.tech/connect. tendr
 * returns it to this site's callback page, which posts { source: 'tendr-connect' } to this window
 * and closes. A popup closed without reporting back is treated as cancelled.
 */
(function () {
  'use strict';

  var strings = window.tendrConnect || {};

  document.addEventListener('click', function (event) {
    var disconnect = event.target.closest('[data-tendr-disconnect]');
    if (disconnect && strings.confirm && !window.confirm(strings.confirm)) {
      event.preventDefault();
    }
  });

  var button = document.querySelector('[data-tendr-connect]');
  if (!button) {
    return;
  }
  var status = document.querySelector('.tendr-connect-status');
  var reported = false;

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) {
      return;
    }
    if (!event.data || event.data.source !== 'tendr-connect') {
      return;
    }
    reported = true;
    window.location.reload();
  });

  button.addEventListener('click', function () {
    var url = button.getAttribute('data-tendr-connect');
    var width = 520;
    var height = 760;
    var left = Math.max(0, (window.screenX || 0) + (window.outerWidth - width) / 2);
    var top = Math.max(0, (window.screenY || 0) + (window.outerHeight - height) / 2);
    reported = false;
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
      if (!reported && status) {
        status.textContent = strings.cancelled || 'Connection cancelled';
      }
    }, 500);
  });
})();
