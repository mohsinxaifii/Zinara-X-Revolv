/**
 * product_click — sitewide.
 *
 * card-product.liquid is the one shared template behind every product card in
 * the theme (collection grid, featured collection, related products, search
 * results, collage), and carries the data-* attributes this reads. Previously
 * this tracking lived only inside main-collection-product-grid.liquid, scoped
 * to `#product-grid li.grid__item` — an id unique to that one section — so
 * product_click only ever fired on the collection page. Delegating on
 * `document` against the shared `.product-card-wrapper` class instead covers
 * every card everywhere with one listener, and needs no per-section wiring.
 *
 * window.customer is set globally in layout/theme.liquid.
 */
(function () {
  document.addEventListener('click', function (event) {
    var card = event.target.closest && event.target.closest('.product-card-wrapper');
    if (!card || !card.dataset.handle) return;

    var customer = window.customer || {};
    // Raw cents from Liquid (card_product.price), not the `| money`-formatted
    // string: a formatted value like "24,999.00" truncates at the comma under
    // parseFloat, silently corrupting price/value for anything over ₹999.
    var price = parseInt(card.dataset.price || 0, 10) / 100;
    var comparePrice = parseInt(card.dataset.comparePrice || 0, 10) / 100;

    var eventData = {
      event: 'product_click',
      event_category: 'Product Grid',
      event_label: card.dataset.title || '',

      product_handle: card.dataset.handle || '',
      price: price,
      compare_at_price: comparePrice,
      value: price,
      currency: 'INR',
      vendor: card.dataset.vendor || '',
      tags: card.dataset.tags ? card.dataset.tags.split(',') : [],

      page_location: window.location.href,
      page_referrer: document.referrer || '',
      page_title: document.title,

      customer_id: customer.id || null,
      customer_email: customer.email || null,
      customer_first_name: customer.first_name || null,
      customer_last_name: customer.last_name || null,
      customer_phone: customer.phone || null,
    };

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(eventData);

    if (typeof gtag === 'function') {
      gtag('event', 'product_click', eventData);
    }

    if (typeof fbq === 'function') {
      fbq('trackCustom', 'product_click', eventData);
    }
  });
})();
