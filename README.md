# Clearance Tracker

A local inventory & price checker: look up a product, enter your ZIP, and see
store-by-store stock, shelf prices, clearance markdowns, price history and a
deals feed. **Walmart is supported today**; the code is organized so more
retailers can be added without touching the API or UI.

No dependencies — just Node.js 20+.

```bash
npm start        # http://localhost:3000
npm test
```

## Features

- **Inventory checker** — search by Walmart item number, UPC, walmart.com link,
  or keywords; results per nearby store with price, stock status, quantity and
  aisle, filterable by radius/availability and sortable by distance or price.
- **Clearance detection** — stores pricing an item well below online are flagged.
- **Price history** chart for each product.
- **Deals** — five sections, each filterable by category and minimum discount:
  Top deals (capped at 2 per category so one category can't take over),
  Price drops today, Lowest price ever, Big-ticket (most dollars off items over
  $100), and Clearance near you (shelf markdowns at stores near your ZIP).
- **Retailer-sold items only** — marketplace/third-party listings are excluded
  everywhere: search, deals and product pages.
- Remembers your ZIP; works on mobile; light/dark theme.

## Data sources (Walmart)

| Mode | Set with | What you get |
| --- | --- | --- |
| `demo` | no keys set | Synthetic catalog, stores and stock. Stable per product/store/day. Good for development and demos. |
| `live` | Walmart I/O keys set (automatic) | Real catalog, online prices and store locations via the [Walmart I/O Affiliate API](https://walmart.io/). |

To go live, create a Walmart I/O account, generate an RSA key pair, upload the
public key, then copy `.env.example` to `.env` and fill in
`WALMART_CONSUMER_ID`, `WALMART_KEY_VERSION`, and either
`WALMART_PRIVATE_KEY_PATH` or `WALMART_PRIVATE_KEY`. Live mode switches on
automatically once those are set (`WALMART_MODE=demo` forces demo data).
Run with `node --env-file=.env src/server.js`.

**Limitation:** Walmart's public API does not expose per-store stock counts, so
in live mode store rows show the online price and "Check store" status. Getting
true store-level inventory requires another data source (a partner feed or
your own collection), which plugs in as a new source class in
`src/retailers/walmart/`. In live mode, price history is built from prices the
app observes over time (saved to `data/price-history.json`).

## How deals are ranked

`src/lib/deals.js` is shared by every retailer. Each candidate the retailer
sells itself and has in stock online gets a score from:

| Signal | Weight |
| --- | --- |
| % off list price | 35% |
| Dollars off (log scale, $1,000 off = max) | 20% |
| Drop since the last recorded price | 15% |
| At the lowest price recorded (needs 7+ days of history) | 10% |
| Rating × review count | 10% |
| Clearance (full) or Rollback (60%) | 10% |

On the home page each product appears only once, in the first section that
picks it. Price drops and lowest-ever depend on the app's own price history,
which grows each time the deal pool refreshes (every 30 minutes while in use),
so they fill in over the first days of running live. On hosts with
temporary disk (like Render's free plan) that history resets on each
deploy or restart.

In live mode the deal pool is Walmart's Trending list, the Clearance and
Rollback feeds, and the first page of each of the top 20 categories.

## Architecture

```
src/
  server.js                 HTTP server + static files (no framework)
  api.js                    /api/:retailer/... routes (retailer-agnostic)
  lib/                      cache, geo (ZIP→state), seeded RNG, price tracker
  retailers/
    RetailerAdapter.js      base class + normalized Product/Store/Availability shapes
    registry.js             the list of enabled retailers
    walmart/
      index.js              WalmartAdapter (input parsing, routes to a source)
      demoSource.js         synthetic data
      liveSource.js         Walmart I/O client (RSA-signed requests)
      catalog.js, identifiers.js
public/                     single-page UI (vanilla JS)
```

### API

| Route | Purpose |
| --- | --- |
| `GET /api/retailers` | enabled retailers, their mode and feature flags |
| `GET /api/:retailer/search?q=` | keyword / item # / UPC / URL search |
| `GET /api/:retailer/products/:id` | product details |
| `GET /api/:retailer/products/:id/inventory?zip=&radius=&sort=` | per-store availability + summary |
| `GET /api/:retailer/products/:id/history?days=` | price history |
| `GET /api/:retailer/stores?zip=` | nearby stores |
| `GET /api/:retailer/deals?section=&zip=&category=&minDiscount=` | one deal section: `top`, `drops`, `lowest`, `bigticket`, `clearance` (needs `zip`) |
| `GET /api/:retailer/deals/sections?zip=&category=` | all sections for the home page |
| `GET /api/:retailer/categories` | categories |

### Adding a retailer

1. Create `src/retailers/<name>/index.js` with a class extending
   `RetailerAdapter`; implement `id`, `name`, `color`, and the methods it can
   support (`searchProducts`, `lookupProduct`, `getProduct`, `findStores`,
   `checkInventory`, `getDealCandidates`, `getLocalClearance`,
   `getCategories`, `getPriceHistory`), returning
   the shapes documented in `RetailerAdapter.js`. Set `seller.isRetailer` on
   every product; only `true` items are shown. Anything left unimplemented
   returns HTTP 501.
2. Register it in `createDefaultRegistry()` in `src/retailers/registry.js`.
3. Remove it from the "coming soon" list (`UPCOMING`) in `public/app.js`.

The new retailer then shows up as a tab in the UI and under `/api/<id>/...`.

## Deploying

`npm start` runs `node src/server.js`, a single web server on `$PORT`
(default 3000) that serves both the UI and the API. Any Node host works.
For Render, `render.yaml` is included: in the Render dashboard choose
**New → Blueprint**, pick this repo, and optionally paste the Walmart I/O
credentials when prompted.
