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
| `add_to_cart` | `items_added` | **Not** bridged from the fbq call — see warning below. Sourced directly from `PUB_SUB_EVENTS.cartUpdate`. |
| `checkout_initiated` | `checkout_started` | Line items come from a live `/cart.js` snapshot; the Meta payload only carries a joined string. **Known to be unreliable** — see warning below. |
| `book_trial_at_home` | `appointment_scheduled` **+** custom `book_trial_at_home` | Standard event so it can be an optimization goal; the custom mirror keeps the two booking types distinguishable. |
| `book_video_trial` | `appointment_scheduled` **+** custom `book_video_trial` | Same. |
| all 27 others | `custom` with `custom_event_name` = the Meta event name | `product_click`, `view_cart`, `filter_applied`, `try_at_home`, the `menu_*` clicks, etc. |

Money is converted to the integer **minor units** (paise) OpenAI expects — this theme
hands Meta major units (`price / 100`), so the bridge multiplies back up.

Advanced matching: the logged-in customer's email / phone / name / ID are SHA-256 hashed
in the browser and passed to `oaiq("init")`. When a form event carries an email or phone
(try-at-home booking, video trial), the bridge re-initialises with those, so the event is
attributed to a known person. Raw values never leave the browser.

## Sitewide reliability audit (2026-09-06)

Went through every fbq/gtag event firing in the theme and checked how each is
actually triggered — not just that the code looks right, but whether the DOM
element or flow it depends on stays valid through this store's specific mix of
AJAX re-renders (variant swap, facet filtering, cart updates) and third-party
interference (GoKwik). Two real, previously-silent breaks were found and fixed;
one is structural and documented but not fixed.

**Fixed: `items_added` (add to cart).** Covered above — moved off the `submit`
DOM event onto `PUB_SUB_EVENTS.cartUpdate`.

**Fixed: `checkout_started` / `checkout_initiated`.** GoKwik's `attach()` scans
for `button[name="checkout"], input[name="checkout"]` sitewide and replaces each
one via `cloneNode(true)` + `replaceChild` (`snippets/gokwik.liquid` ~line 658) to
attach its own checkout flow. `cloneNode` copies attributes (so the clone keeps
`id="CartDrawer-Checkout"` and `name="checkout"`) but never copies
`addEventListener` listeners, so the click listener in `cart-drawer.liquid` that
fired `checkout_initiated` was attached to a node GoKwik removes from the DOM
before a real user ever clicks it — it could not have fired since GoKwik started
claiming that button.

There is no way to observe the click via normal delegation afterwards either:
GoKwik's own capture-phase listener on `window` (registered at the very top of
`<head>`) calls `stopImmediatePropagation()` once it claims the click, which
blocks every listener registered after it for that dispatch, including one added
via `document.addEventListener(..., true)` anywhere later in the page.

**Fix applied:** a capture-phase `click` listener is registered on `window` at
the very top of `<head>` in `layout/theme.liquid`, before GoKwik's own script
renders. Capture-phase listeners on the same target fire in registration order,
so this one runs and dispatches a plain `theme:checkout-intent` custom event
*before* GoKwik's listener gets to stop anything — dispatching a new event is
unaffected by `stopImmediatePropagation()` on the original click, since that only
blocks further listeners in the *original* click's chain. `cart-drawer.liquid`
now listens for `theme:checkout-intent` instead of a direct click on
`#CartDrawer-Checkout`. Verified against a simulation of GoKwik's exact
clone-and-stop behavior before shipping.

This also unifies coverage: the same selector matches the checkout buttons in
`cart-notification.liquid` and `sections/main-cart-footer.liquid`, neither of
which had *any* tracking before (only the cart drawer's button did) — a click on
any of the three now fires `checkout_started`. Only the drawer's cart type is
live on this store today (`cart_type: drawer` in `config/settings_data.json`);
if that setting is ever switched to `notification` or `page`, the listener body
itself (in `cart-drawer.liquid`) stops being rendered and would need to move to
a snippet included regardless of cart type.

**Fixed: `filter_applied` and `ready_to_ship` were both completely dead —
a truncated script tag.** `snippets/facets.liquid`'s `ready_to_ship` script
(~line 1618) was cut off mid-statement with no closing `});` or `</script>`.
Browsers scan for the literal text `</script>` to close a script element,
ignoring any `<script>` tags found inside it — so everything from that broken
script through the *next* real `</script>` (which was `filter_applied`'s,
~90 lines later) was being parsed by the browser as **one script**, containing
a truncated object literal and bare `<script>` tokens partway through. That is a
syntax error, and a syntax error in a `<script>` block means none of it runs —
so neither event could ever have fired, on any page, regardless of GoKwik.
Completed the truncated statement and closed the tag properly.

**Fixed: `filter_applied` also didn't survive a facet re-render.** Once the
script was actually valid JS, it still had a real bug: Dawn's own
`assets/facets.js` (`renderFilters`) replaces the `innerHTML` of every
`.js-filter` details block that wasn't the one just toggled, on every filter
submission — normal, filters are meant to update counts across all groups. The
listener was bound directly to each `li.facets__item` at page load, so it
survived exactly one click per filter group and silently stopped after that.
Rewritten as delegation on `document` (`event.target.closest(...)`), which
re-resolves the target on every click and is immune to the element being
replaced. `ready_to_ship`'s own link sits outside the facet groups entirely
(a static link to `/collections/ready-to-ship`), so it was never affected by
this specific issue — only by the truncation.

**Fixed, unrelated to tracking:** the header's `.c-menu2` "Try at Home" link
(`sections/header.liquid`) called `preventDefault()` but — unlike its `shop_all`
and `about_us` siblings in the same handler — never redirected afterward, so the
click did nothing beyond firing tracking. Added the missing redirect.

**Checked and already reliable, no change needed:** `add_product_tryathome` /
`remove_product_tryathome` (properly deduped with `removeEventListener` before
re-adding), `select_time_slot_tryathome`, `book_trial_at_home` /
`book_video_trial`, `view_cart`, `view_wishlist`, `view_product_list`,
`product_click`, `category_click`, `occasion_click`, `home_banner_click`,
`home_carousel_banner`, `try_at_home` (all three separate bindings: header
desktop menu, header burger drawer, homepage try-at-home section — each scoped
to its own element/source, not duplicates of each other), `menu_click` and the
other `menu_*` drawer events (all null-guarded, bound to the static mobile menu
drawer which isn't AJAX-replaced), `price_breakdown` and `check_availability_ship`
(both live inside `<product-info>`, whose inline scripts Dawn's own
`HTMLUpdateUtility.viewTransition` deliberately re-executes on every variant
swap — confirmed in `assets/global.js`), `check_availability_tryathome` (its
button lives outside `<product-info>`, in the static part of the page, so it's
never touched by a variant swap).

**Noted, not fixed (not a tracking issue):** `snippets/facets.liquid` (~line
1603) hides certain filter values using a hardcoded, page-specific section ID
(`#Facet-3-template--24203645616312__product-grid`) instead of
`{{ section.id }}` — works only on the one page that ID happened to belong to
when it was written, silently does nothing on every other collection page.
Flagging since it's directly adjacent to what was audited, but it's a filter
display bug, not a conversion-tracking one, so left alone.

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
