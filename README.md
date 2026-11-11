# Clearance Tracker

Deals at Walmart, online and on the shelf at the stores near you: Clearance,
Rollback, Reduced Price and our own **Markdown** label, with store-by-store
prices and stock. Only items Walmart itself sells, never marketplace sellers.
**Walmart is supported today**; the code is organized so more retailers can be
added without touching the API or UI.

Live at https://clearance-tracker.onrender.com. No dependencies, just Node.js
22.13+ (it uses Node's built-in SQLite and test runner).

```bash
npm start        # http://localhost:3000 (demo data without Walmart keys)
npm test
```

## Pages

- **All Deals** (`#/`): one card per item with up to two deal lines, **Online**
  (Walmart.com) and **In store** (the cheapest nearby store with a deal, how
  many other stores have one, and when it was checked). Filter by Online Deals
  / In Store Deals, badge (Clearance, Rollback, Reduced Price, Markdown, Price
  drop, Lowest price ever), category, minimum discount, price range and text;
  sort by best match, % off, $ off, price or biggest recent drop.
- **In Store Deals** (`#/stores`): the same, for items with a store deal.
- **Search** (`#/search`): every item Walmart sells, online and in stores, 25 at
  a time. An item number, UPC or walmart.com link opens the product page.
- **Product page**: the online deal, one list of the 15 nearest stores (plus
  farther tracked stores with a saved price) with each store's price, stock and
  deal label, "Check store" / "Check all stores" for a live lookup, and a
  price history chart for Walmart.com or any store with a saved price (store
  prices go back 14 days).
- The ZIP in the top bar picks the nearby stores; it is remembered.

## How the data is collected (Walmart, live mode)

Everything uses Walmart's free [affiliate API](https://walmart.io/). Every
night (Chicago time), paced at about 28 calls a minute:

1. **4:00, lists:** Walmart's search (Clearance, Rollback, Reduced Price; sold
   by Walmart; carried in stores) for every department in
   `config/store-scan.json`, then Walmart's deal feeds (sold by Walmart only).
2. **5:00, store checks:** the item lookup with a store number returns that
   store's price, stock, Clearance flag and was-price. Deal items are checked at
   the 3 daily stores and 4 rotating ones, Clearance and store deals at the
   other tracked stores, and Walmart.com's own price for every deal item.
3. **Mondays, Tier 3:** the list of everything Walmart sells in stores in those
   departments is rebuilt from department and subcategory searches.
4. **Until 20:00:** Tier 3 items are checked at the daily stores, a slice a
   day, to find store-level Markdowns Walmart doesn't tag.

Pages read only saved data, so visitors never wait on Walmart (except
"Check store", capped at 120 lookups an hour). Details, settings and the exact
deal-label rules: [`config/README.md`](config/README.md). What each Walmart
call really returns: [`CLAUDE.md`](CLAUDE.md).

## How deals are ranked ("Best match")

Each card's best deal line gets a score (`src/lib/allDeals.js`):

| Signal | Weight |
| --- | --- |
| % off the reference price | 0.35 |
| Dollars off (log scale, $1,000 off = full) | 0.20 |
| Online price drop since the last recorded day (33% drop = full) | 0.15 |
| At the lowest online price recorded (needs 7+ days of history) | 0.10 |
| Deal kind: Clearance 1, Rollback / Reduced Price 0.6, Markdown 0.5 | 0.10 |

## Modes

| Mode | Set with | What you get |
| --- | --- | --- |
| `demo` | no keys set | Synthetic catalog, stores and stock, stable per product/store/day. |
| `live` | Walmart I/O keys set (automatic) | Real items, store prices and stock (in stock or not; Walmart gives no counts). |

To go live, create a Walmart I/O account, generate an RSA key pair, upload the
public key, then copy `.env.example` to `.env` and fill in
`WALMART_CONSUMER_ID`, `WALMART_KEY_VERSION`, and either
`WALMART_PRIVATE_KEY_PATH` or `WALMART_PRIVATE_KEY` (`WALMART_MODE=demo`
forces demo data). Run with `node --env-file=.env src/server.js`.
`WALMART_PUBLISHER_ID` (from Walmart's affiliate program on Impact) turns on
affiliate tracking in every walmart.com link and the footer disclosure.

## Architecture

```
src/
  server.js                 HTTP server, static files, starts the daily checks
  api.js                    /api/:retailer/... routes (retailer-agnostic)
  lib/
    allDeals.js             deal cards: filters, sorting, score, price signals
    priceTracker.js         SQLite database + online price history
    scanConfig.js           reads and validates config/store-scan.json
    scanSchedule.js         Chicago-time clock helpers
    cache.js, geo.js, random.js
  retailers/
    RetailerAdapter.js      base class + normalized Product/Store/Availability shapes
    registry.js             the list of enabled retailers
    walmart/
      index.js              WalmartAdapter: pages from saved data
      liveSource.js         Walmart I/O client (RSA-signed requests)
      storeChecker.js       the daily cycle (lists, store checks, Tier 3)
      tierLists.js          tier 1/2/3 lists and the search queue
      storePrices.js        store prices, online lookups, deal labels
      demoSource.js, catalog.js, identifiers.js
public/                     single-page UI (vanilla JS)
config/store-scan.json      stores, departments, schedule (see config/README.md)
```

### API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | health check |
| `GET /api/retailers` | enabled retailers, their mode and feature flags |
| `GET /api/:retailer/all-deals?zip=&where=&labels=&q=&category=&minDiscount=&minPrice=&maxPrice=&sort=&offset=&limit=` | deal cards |
| `GET /api/:retailer/search?q=&start=` | keyword / item # / UPC / link search, 25 per page |
| `GET /api/:retailer/products/:id` | product details, store offers and online deal |
| `GET /api/:retailer/products/:id/inventory?zip=&sort=distance\|price` | the store list for a ZIP |
| `GET /api/:retailer/products/:id/check-store?store=` | live lookup at one store (live mode) |
| `GET /api/:retailer/products/:id/history?zip=` | online price history, and each store's (nearby ones with `zip`) |
| `GET /api/:retailer/stores?zip=` | nearby stores |
| `GET /api/:retailer/store-check` | progress of the daily cycle |
| `GET /api/:retailer/scan-config` | the settings, checked against Walmart's departments |
| `GET /api/:retailer/debug/item/:id?storeId=`, `/debug/feed`, `/debug/taxonomy` | raw Walmart responses, for diagnostics |

### Adding a retailer

1. Create `src/retailers/<name>/index.js` with a class extending
   `RetailerAdapter`; implement `id`, `name`, `color`, and the methods it can
   support (`searchProducts`, `lookupProduct`, `getProduct`, `findStores`,
   `checkInventory`, `getDealCandidates`, `getLocalClearance`,
   `getPriceHistory`, or its own `allDealCards`), returning the shapes
   documented in `RetailerAdapter.js`. Set `seller.isRetailer` on every
   product; only `true` items are shown. Anything left unimplemented returns
   HTTP 501.
2. Register it in `createDefaultRegistry()` in `src/retailers/registry.js`.

## Deploying

`npm start` runs `node src/server.js`, one web server on `$PORT` (default
3000) for the UI and the API. Render auto-deploys `main` from `render.yaml`
(starter plan with a 1 GB disk for the database at `DATABASE_PATH`). Store
prices are kept 14 days; the daily prune cuts the store price history to 7 days
if the database is over 700 MB.
