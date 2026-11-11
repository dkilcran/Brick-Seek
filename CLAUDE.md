# Clearance Tracker: notes for Claude

## Working with the owner

- If adding a domain to the cloud environment's allowed network list would help
  (docs, APIs, data sources), say so and name the domain, instead of working
  around it.
- Commit and push straight to `main`; the owner reverts if needed. Render
  auto-deploys `main` (https://clearance-tracker.onrender.com).
- Verify changes on the live site (`/api/walmart/store-check`, `/all-deals`,
  a product page), not just with tests. Push only when `npm test` passes.
  When startup or the schema changes, also boot the new code against a
  database made by the previous commit before pushing (a failed boot keeps
  the old version running on Render).
- Give a time estimate before multi-step work and report the actual time.
  Estimates have run 3-12x too long (Nov 10: 2-3 h -> 55 min; 1.5 h -> 7 min;
  2-2.5 h -> 13 min), from pricing steps at a person's speed. Count the fixed
  waits instead: a Render deploy ~60-70 s, a Walmart rate-limit wait ~30-60 s,
  a production-size timing run ~20 s; then a code change with tests, push and
  live check is 5-15 min, a Walmart measurement 1-2 min, a large refactor
  about an hour. The machine's clock is accurate (it matches the live
  server's Date header); compare each actual time with the estimate.

## What the data sources really return (learned the hard way)

- **Walmart affiliate API without `storeId`** returns only the default
  shippable online offer: often a marketplace seller, and prices can lag
  (Cricut mat said $10.97 when Walmart charged $7.97). Its `msrp` is unreliable.
  Bulk feeds (`/paginated/items`, special offers) name a seller on ~1% of items.
- **The same `/items` lookup with `storeId=<store>`** returns Walmart's offer
  at that store: price, store stock (`stock`), `clearance` flag and was-price
  (`strikeThroughPrice`), matching SerpApi item for item. Up to 20 ids per call.
  `zipCode` alone does nothing. The bulk feeds ignore `storeId`.
- **Walmart `/search`** (free) takes `facet=on` and repeated `facet.filter`
  (`special_offers:Clearance|Rollback|Reduced Price`, `retailer_type:Walmart`,
  `fulfillment_method:In-store`), 25 per page, paged with `start`, which must be
  under 1,000 (so at most 1,000 results per search). `facet.range=price:[lo TO hi]`
  works with whole dollars only. It ignores `storeId`. `categoryId` (taxonomy id,
  subcategories like `4044_90548` too) does filter, together with the facets
  ("lamp" in-store: 207; with Home > Appliances: 0). A query is still required
  and drives results erratically ("home" in Home in-store: 14,725; "a": 6;
  "with": 63); there is no match-everything query. Builds the daily tier
  lists; the store lookup confirms each item.
- Synchronous SQLite blocks the whole server: anything a page calls must stay
  fast at production size (800k+ current prices). Time new queries on a
  realistic test database before pushing; a 28s query got the site restarted.
- `storeId` on `/items` is undocumented (docs list only `ids`, `upc`,
  `publisherId`), so it could change without notice.
- **`/items` with `storeId` also answers for items sold online only**
  (`offerType: "ONLINE_ONLY"`), with the online price at every store; those
  are dropped. It has a `clearance` flag but no Rollback flag; Rollback and
  Reduced Price come from the `/search` facet lists. `strikeThroughPrice` is
  often just a reference "was" price on items with no offer, and `msrp` can
  be below the sale price.
- **Walmart's own online price**: `/search` with `retailer_type:Walmart` returns
  Walmart-sold online prices; `/items` without `storeId` only when its seller
  is Walmart (else it's a marketplace offer). Store prices above it aren't deals.
- **Finding hidden parameters**: Walmart's API has no OpenAPI/Swagger file; it
  ignores unknown parameters but rejects a wrong value for a known typed one,
  naming it (try `<name>=notanumber` on a call). Feed:
  `soldByWmt`, `available` (booleans), `count`, `lastDoc`, `remainingHits`;
  no sort, price or date filters. The docs app's `/feeds/*`, `/clearance` and
  `/specialbuy` endpoints answer "No endpoint" for our account.
- **Bulk feeds** (`/paginated/items?category=&specialOffer=clearance|rollback|reduced`)
  are ~99% marketplace unless `soldByWmt=true`, which makes Walmart drop them
  (Home Clearance: 12,000+ listings -> 125). 200 items per page, `nextPage` to
  continue; rate-limited harder than other calls (wait ~60s on 429). They don't
  say whether an item is in stores; a lookup does (~73% of deal-feed items are
  online only). Ordered by item id; `lastDoc=<id>` starts after an id (newer
  listings have higher ids). Without a deal filter they're huge (Home, sold by
  Walmart: 6.65M; `available=true`: 2.5M, ~10% in stores), but `brand=` with a
  Walmart store brand (Mainstays, Great Value, Hyper Tough, Ozark Trail) is
  small and ~95% in stores. `brand=` is loose (other brands come along).
- **Top of a department feed** (Home, Nov 11): real listings end around id
  21.4B; above them come unpriced items, priced digital video episodes filed
  as Home decor (ids ending 001-003, "Not available", unknown to `/items`)
  up to ~55B, and a few 12-digit ids (190052277878). Walmart-sold Home
  listings run ~200 per 1-9M ids. `remainingHits` is the feed's total, not
  what's left. `isShelfListing` filters these.
- **Affiliate links**: Walmart's program runs on Impact. `productTrackingUrl`
  is `goto.walmart.com/c/{publisherId}/568844/9383?veh=aff&sourceid=imp_000011112222333344&u={item url}`
  (`|PUBID|` when no publisherId is sent); `walmartProductUrl` builds it.
- **SerpApi** (paid; its code was removed Nov 2026, see git history): `engine=walmart` with `store_id`
  and facets finds store clearance; `engine=walmart_product` with `store_id`
  adds aisle and pickup availability. 250 searches/month on the free plan.
- Walmart's `categoryPath` starts with "Home Page/"; the department is the next segment.
- `msrp` of 9999 is a placeholder, not a list price.
