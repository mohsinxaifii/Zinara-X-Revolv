/**
 * OpenAI Ads (ChatGPT Ads) — event bridge.
 *
 * This theme already fires a full set of Meta Pixel events (fbq) from ~15 files.
 * Rather than duplicating an oaiq call next to each one, this file proxies fbq
 * and mirrors every Meta event to the OpenAI pixel, mapping the commerce ones
 * onto OpenAI standard events and passing everything else through as a custom
 * event of the same name.
 *
 * Base pixel + helpers: snippets/openai-ads-pixel.liquid
 * Event reference: https://developers.openai.com/ads/supported-events
 */
(function () {
  var OA = window.OpenAIAds;
  if (!OA) return;

  var config = OA.config;

  // ---------------------------------------------------------------------------
  // Meta event -> OpenAI event mapping.
  //
  //   event:   OpenAI standard event name, or null to send a custom event using
  //            the Meta event name.
  //   shape:   'contents' | 'customer_action' | 'custom' (the data.type the
  //            event expects — see supported-events docs).
  //   mirror:  also send the Meta name as a custom event, so a standard event
  //            shared by two flows can still be told apart in reporting.
  //   skip:    handled natively elsewhere, ignore the Meta call.
  // ---------------------------------------------------------------------------
  var EVENT_MAP = {
    PageView: { skip: true }, // fired by snippets/openai-ads-pixel.liquid
    // GoKwik's cart embed attaches its own capture-phase click listener to
    // .product-form__submit and calls preventDefault (see product-form.js), so the
    // form's `submit` event — and this fbq call — do not reliably fire. items_added
    // is sent from the cartUpdate pub/sub below instead, which fires from inside
    // product-form.js's own successful fetch response and is what the cart
    // drawer/notification already depend on to render.
    add_to_cart: { skip: true },
    checkout_initiated: { event: 'checkout_started', shape: 'contents' },
    book_trial_at_home: { event: 'appointment_scheduled', shape: 'customer_action', mirror: true },
    book_video_trial: { event: 'appointment_scheduled', shape: 'customer_action', mirror: true }
  };

  // Meta payload keys that carry a monetary value, in major units (₹) — this
  // theme divides Shopify's minor units by 100 before handing them to fbq.
  var VALUE_KEYS = ['value', 'cart_value', 'total_price', 'revenue', 'amount', 'price'];

  // Meta payload keys that carry identity we can use for advanced matching.
  var IDENTITY_KEYS = {
    email: ['email', 'customer_email'],
    phone: ['phone', 'customer_phone'],
    externalId: ['customer_id'],
    postalCode: ['pincode', 'customer_zip'],
    city: ['customer_city'],
    region: ['customer_state']
  };

  function first(props, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = props[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  // Meta values are in major units; OpenAI wants an integer in minor units.
  function majorToMinor(value) {
    var n = typeof value === 'string' ? parseFloat(value) : value;
    if (typeof n !== 'number' || !isFinite(n)) return undefined;
    return Math.round(n * 100);
  }

  function sanitizeCustomName(name) {
    var clean = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '')
      .slice(0, 64);
    return clean || null;
  }

  // ---------------------------------------------------------------------------
  // Live cart snapshot — seeded from Liquid, refreshed whenever the cart changes,
  // so checkout_started can send real line items (the Meta payload only carries a
  // "Name (Qty: 1, ₹123)" string).
  // ---------------------------------------------------------------------------
  var cart = (config && config.cart) || { items: [], amount: 0, item_count: 0 };

  function refreshCart() {
    return fetch(window.Shopify && window.Shopify.routes ? window.Shopify.routes.root + 'cart.js' : '/cart.js', {
      headers: { Accept: 'application/json' }
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (state) {
        cart = { items: state.items || [], amount: state.total_price, item_count: state.item_count };
        OA.log('cart snapshot updated', cart);
      })
      .catch(function () {
        /* keep the previous snapshot */
      });
  }

  // Shopify's /cart/add.js returns either the single added line item flat
  // (product-form.js) or `{ items: [...] }` for the ones just added (quick-add-bulk),
  // never the full cart — so this is exactly the items_added payload, not a diff.
  function contentsFromCartUpdate(cartData) {
    if (!cartData) return null;
    if (Array.isArray(cartData.items)) return OA.contents(cartData.items);
    if (cartData.variant_id) return OA.contents([cartData]);
    return null;
  }

  if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
    subscribe(PUB_SUB_EVENTS.cartUpdate, function (event) {
      refreshCart();

      // Only 'product-form' (main/sticky add-to-cart) and 'quick-add' (collection
      // grid quick add) represent a genuine new addition; 'cart-items' is a
      // quantity edit on a line already in the cart.
      if (event.source !== 'product-form' && event.source !== 'quick-add') return;

      var contents = contentsFromCartUpdate(event.cartData);
      if (!contents || !contents.length) return;

      var amount = contents.reduce(function (sum, item) {
        return sum + (item.amount || 0) * (item.quantity || 1);
      }, 0);

      OA.track('items_added', {
        type: 'contents',
        amount: amount,
        currency: OA.currency,
        contents: contents
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Per-event data builders. Each returns the `data` object for oaiq measure.
  // ---------------------------------------------------------------------------
  function contentsFromMeta(props) {
    // add_to_cart carries a single product, flat on the payload.
    if (props.product_id || props.variant_id) {
      return [
        {
          id: String(props.sku || props.variant_id || props.product_id),
          name: props.product_title || props.title || '',
          content_type: 'product',
          quantity: props.quantity || 1,
          amount: majorToMinor(props.price),
          currency: props.currency || OA.currency
        }
      ];
    }

    // product_click on the collection grid.
    if (props.product_handle) {
      return [
        {
          id: String(props.product_handle),
          name: props.event_label || props.product_title || '',
          content_type: 'product',
          quantity: 1,
          amount: majorToMinor(props.price),
          currency: props.currency || OA.currency
        }
      ];
    }

    return null;
  }

  function buildData(metaEvent, mapping, props) {
    var shape = mapping.shape || 'custom';
    var data = { type: shape === 'customer_action' ? 'customer_action' : shape === 'contents' ? 'contents' : 'custom' };

    var value = majorToMinor(first(props, VALUE_KEYS));

    if (metaEvent === 'add_to_cart') {
      var lineTotal = majorToMinor(props.price);
      if (lineTotal !== undefined) value = lineTotal * (props.quantity || 1);
    }

    if (data.type === 'contents') {
      var contents = contentsFromMeta(props);

      // checkout_initiated: use the live cart, the Meta payload has no line items.
      if (!contents && metaEvent === 'checkout_initiated') {
        contents = OA.contents(cart.items);
        if (value === undefined) value = OA.amount(cart.amount);
      }

      if (contents && contents.length) data.contents = contents;
    }

    if (value !== undefined) {
      data.amount = value;
      data.currency = props.currency || OA.currency;
    }

    return data;
  }

  function identityFromMeta(props) {
    var raw = {};
    var found = false;

    Object.keys(IDENTITY_KEYS).forEach(function (field) {
      var value = first(props, IDENTITY_KEYS[field]);
      if (value) {
        raw[field] = value;
        found = true;
      }
    });

    // Forms hand over a single "name" / "customer_name" field.
    var fullName = first(props, ['name', 'customer_name']);
    if (fullName && typeof fullName === 'string' && fullName.trim()) {
      var parts = fullName.trim().split(/\s+/);
      raw.firstName = parts[0];
      if (parts.length > 1) raw.lastName = parts.slice(1).join(' ');
      found = true;
    }

    return found ? raw : null;
  }

  // ---------------------------------------------------------------------------
  // Bridge
  // ---------------------------------------------------------------------------
  function forward(args) {
    var command = args[0];
    if (command !== 'track' && command !== 'trackCustom' && command !== 'trackSingle' && command !== 'trackSingleCustom') {
      return;
    }

    // trackSingle* put the pixel id first.
    var offset = command.indexOf('Single') === 5 ? 1 : 0;
    var metaEvent = args[1 + offset];
    var props = args[2 + offset] || {};

    if (!metaEvent) return;

    var mapping = EVENT_MAP[metaEvent] || {};
    if (mapping.skip) return;

    // Booking/lead forms give us an email and phone — upgrade advanced matching
    // before the event goes out so it is attributed to a known person.
    var identity = identityFromMeta(props);
    if (identity) OA.identify(identity);

    if (mapping.event) {
      OA.track(mapping.event, buildData(metaEvent, mapping, props));
      if (!mapping.mirror) return;
    }

    var customName = sanitizeCustomName(metaEvent);
    if (!customName) return;

    OA.track('custom', buildData(metaEvent, { shape: 'custom' }, props), { custom_event_name: customName });
  }

  function bridge() {
    var fbq = window.fbq;
    if (typeof fbq !== 'function' || fbq.__openaiBridged) return false;
    if (typeof window.Proxy !== 'function' || typeof window.Reflect !== 'object') return false;

    // A Proxy keeps fbq fully transparent — fbevents.js still reads and writes
    // queue/callMethod/loaded on the original function object.
    window.fbq = new window.Proxy(fbq, {
      apply: function (target, thisArg, args) {
        try {
          forward(args);
        } catch (error) {
          OA.log('bridge error', error);
        }
        return window.Reflect.apply(target, thisArg, args);
      }
    });
    window.fbq.__openaiBridged = true;
    OA.log('bridged Meta pixel events');
    return true;
  }

  if (!bridge()) {
    // The Meta stub is defined in the <head>, but bridge defensively in case the
    // pixel is moved or injected later.
    var attempts = 0;
    var timer = setInterval(function () {
      if (bridge() || ++attempts > 20) clearInterval(timer);
    }, 250);
  }
})();
