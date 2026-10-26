/**
 * "Pay with crypto" in the WooCommerce Blocks checkout. Placing the order runs the gateway's
 * process_payment() on the server, which redirects to the order-pay step where the tendr modal
 * opens, so this only registers the method's label and description.
 */
(function () {
  'use strict';

  var registry = window.wc && window.wc.wcBlocksRegistry;
  var settings = window.wc && window.wc.wcSettings;
  var element = window.wp && window.wp.element;
  var entities = window.wp && window.wp.htmlEntities;
  if (!registry || !settings || !element) return;

  var data = settings.getSetting('tendr_data', {}) || {};
  var decode =
    entities && entities.decodeEntities
      ? entities.decodeEntities
      : function (s) {
          return s;
        };
  var title = decode(data.title || 'Pay with crypto');
  var description = decode(data.description || '');

  function Content() {
    return description ? element.createElement('p', null, description) : null;
  }

  function Label() {
    return element.createElement('span', null, title);
  }

  registry.registerPaymentMethod({
    name: 'tendr',
    label: element.createElement(Label),
    ariaLabel: title,
    content: element.createElement(Content),
    edit: element.createElement(Content),
    placeOrderButtonLabel: decode(data.buttonLabel || title),
    canMakePayment: function () {
      return true;
    },
    supports: { features: Array.isArray(data.supports) ? data.supports : ['products'] },
  });
})();
