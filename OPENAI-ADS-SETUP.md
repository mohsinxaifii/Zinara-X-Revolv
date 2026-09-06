# OpenAI Ads (ChatGPT Ads) — setup notes

Pixel: **webzinara** · `GNxEfvYwDmKGWysLzjYCTt` · SDK `https://bzrcdn.openai.com/sdk/oaiq.min.js`
Docs: <https://developers.openai.com/ads/measurement-pixel> · <https://developers.openai.com/ads/supported-events>

## What is installed in the theme

| File | Role |
| --- | --- |
| `snippets/openai-ads-pixel.liquid` | Loads the SDK, `oaiq("init")`, SHA-256 advanced matching, fires `page_viewed`. Rendered from `layout/theme.liquid` right after the Meta Pixel. |
| `assets/openai-ads.js` | Proxies `window.fbq` and mirrors **every** Meta Pixel event in this theme to OpenAI. |
| `snippets/openai-ads-product-viewed.liquid` | Fires `contents_viewed` on the product page. Rendered from `sections/main-product.liquid`. |
| `config/settings_schema.json` → "OpenAI Ads" | Enable toggle, pixel ID, debug logging. |

Nothing about the existing Meta / GA4 / GTM tracking was changed. The bridge is a
transparent `Proxy` around `fbq`, so Meta keeps receiving exactly what it received before.

## Event map

The theme fires 33 distinct Meta events. They arrive at OpenAI like this:

| Meta event | OpenAI event | Notes |
| --- | --- | --- |
| `PageView` | `page_viewed` | Fired directly by the pixel snippet, not via the bridge, so it does not depend on Meta loading. |
| *(new)* | `contents_viewed` | Product page view. The theme has no Meta equivalent — added because it is a core conversion event. |
| `add_to_cart` | `items_added` | Line item + unit price + quantity. |
| `checkout_initiated` | `checkout_started` | Line items come from a live `/cart.js` snapshot; the Meta payload only carries a joined string. |
| `book_trial_at_home` | `appointment_scheduled` **+** custom `book_trial_at_home` | Standard event so it can be an optimization goal; the custom mirror keeps the two booking types distinguishable. |
| `book_video_trial` | `appointment_scheduled` **+** custom `book_video_trial` | Same. |
| all 27 others | `custom` with `custom_event_name` = the Meta event name | `product_click`, `view_cart`, `filter_applied`, `try_at_home`, the `menu_*` clicks, etc. |

Money is converted to the integer **minor units** (paise) OpenAI expects — this theme
hands Meta major units (`price / 100`), so the bridge multiplies back up.

Advanced matching: the logged-in customer's email / phone / name / ID are SHA-256 hashed
in the browser and passed to `oaiq("init")`. When a form event carries an email or phone
(try-at-home booking, video trial), the bridge re-initialises with those, so the event is
attributed to a known person. Raw values never leave the browser.

## Ads Manager — conversions (already created)

Created via the Ads API on 2026-09-06 against ad account
`adacct_6a993c4d827081a08efd4b4ec709bc85` (Inditren Technologies Private Limited).
All 35 are attached to data source `cds_6a9b1e708e4881a08b0b2953678c90ce` (`webzinara`)
with a 30-day attribution window. The list matches exactly what the theme fires —
nothing speculative was created.

**Standard events (5)** — only these can be a campaign optimization goal:

| Conversion name | Event type |
| --- | --- |
| Page View | `page_viewed` |
| Product Viewed | `contents_viewed` |
| Add to Cart | `items_added` |
| Checkout Started | `checkout_started` |
| Trial Booked | `appointment_scheduled` |

**Custom events (30)** — reporting and audiences only, mirrored 1:1 from the theme's
Meta events: `about_us`, `add_product_tryathome`, `book_trial_at_home`,
`book_video_trial`, `category_click`, `check_availability_ship`,
`check_availability_tryathome`, `filter_applied`, `get_own_design`,
`home_banner_click`, `home_carousel_banner`, `homepage_view`, `menu_buyback_click`,
`menu_category_click`, `menu_click`, `menu_exchange_click`, `menu_orders_click`,
`menu_shop_click`, `occasion_click`, `page_view_custom`, `price_breakdown`,
`product_click`, `ready_to_ship`, `remove_product_tryathome`,
`select_time_slot_tryathome`, `shop_all`, `try_at_home`, `view_cart`,
`view_product_list`, `view_wishlist`.

**Not created: `order_created`.** Nothing in the theme fires it yet — add the conversion
event only once the checkout-side setup below is live, otherwise it sits at zero.

To manage these later, either use Ads Manager → Tools → Conversions, or the API:

```
GET  https://api.ads.openai.com/v1/conversions/event_settings?limit=100
POST https://api.ads.openai.com/v1/conversions/event_settings
Authorization: Bearer <ads api key>

{"name":"Purchases","event_type":"order_created","attribution_window_days":30,
 "source_ids":["cds_6a9b1e708e4881a08b0b2953678c90ce"]}
```

Note: the API is behind a WAF that rejects some HTTP clients with `403 error code: 1010`
(a Cloudflare browser-signature block, not a permissions problem). `curl` works.

## `order_created` — the one event that cannot come from the theme

Checkout is outside the theme, and this store uses **GoKwik** one-click checkout, so
Shopify's own `checkout_completed` may not fire for every order. Two options.

### Option A — Shopify Custom Pixel (quick)

Admin → **Settings → Customer events → Add custom pixel**, paste:

```js
const PIXEL_ID = 'GNxEfvYwDmKGWysLzjYCTt';

!(function (w, d, s, u) {
  if (w.oaiq) return;
  var q = function () { q.q.push(arguments); };
  q.q = []; w.oaiq = q;
  var j = d.createElement(s); j.async = 1; j.src = u;
  var f = d.getElementsByTagName(s)[0];
  f.parentNode.insertBefore(j, f);
})(window, document, 'script', 'https://bzrcdn.openai.com/sdk/oaiq.min.js');

oaiq('init', { pixelId: PIXEL_ID, debug: true });

analytics.subscribe('checkout_completed', (event) => {
  const checkout = event.data.checkout || {};
  const price = (money) => (money && money.amount ? Math.round(money.amount * 100) : undefined);

  oaiq(
    'measure',
    'order_created',
    {
      type: 'contents',
      amount: price(checkout.totalPrice),
      currency: checkout.currencyCode,
      contents: (checkout.lineItems || []).map((item) => ({
        id: String((item.variant && (item.variant.sku || item.variant.id)) || item.id),
        name: item.title,
        content_type: 'product',
        quantity: item.quantity,
        amount: price(item.variant && item.variant.price),
        currency: checkout.currencyCode
      }))
    },
    // Reuse the order id as event_id so a server-side send of the same order dedupes.
    { event_id: String((checkout.order && checkout.order.id) || checkout.token) }
  );
});
```

Then place an order and confirm it lands in the Event Stream. **If GoKwik orders do not
appear, Option B is required** — that is the thing to verify first after deploying.

### Option B — Conversions API (reliable, recommended for GoKwik)

Send `order_created` server-side from a Shopify `orders/create` webhook:

```
POST https://bzr.openai.com/v1/events?pid=GNxEfvYwDmKGWysLzjYCTt
Authorization: Bearer <API-KEY>
Content-Type: application/json

{"events":[{
  "id": "<shopify order id>",
  "type": "order_created",
  "timestamp_ms": 1773892800000,
  "action_source": "web",
  "user": { "emails_sha256": ["<sha256>"], "phones_sha256": ["<sha256>"] },
  "data": { "type": "contents", "amount": 249900, "currency": "INR", "contents": [...] }
}]}
```

Same `id` as Option A's `event_id` → OpenAI keeps the first and drops the duplicate, so
both can run together safely.

For attribution to work server-side the event should carry `oppref`. The pixel stores it
in a first-party `__oppref` cookie on landing; to reach the webhook, copy that cookie into
a cart attribute at add-to-cart time and read it off the order. Not implemented yet —
worth adding if Option B becomes the primary path.

## Verifying

1. Ads Manager → **Conversions → Event Stream** → enable event listening.
2. Browse the store: home → collection → product → add to cart → checkout.
3. Debug logging is on by default, so the browser console shows every call as
   `[openai-ads] measure …`. `oaiq` itself also logs with `debug: true`.
4. Once the Event Stream looks right, turn **Debug logging** off in
   Theme settings → OpenAI Ads.
