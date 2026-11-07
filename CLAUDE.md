# Clearance Tracker: notes for Claude

## Working with the owner

- If adding a domain to the cloud environment's allowed network list would help
  (docs, APIs, data sources), say so and name the domain, instead of working
  around it.
- Commit and push straight to `main`; the owner reverts if needed. Render
  auto-deploys `main` (https://clearance-tracker.onrender.com).
- Verify changes on the live site (the `/api/walmart/stats`, `/store-scan`,
  `/store-check` endpoints), not just with tests. Push only when `npm test` passes.
- Give a time estimate before multi-step work and report the actual time.

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
  works with whole dollars only. It ignores `storeId` and `categoryId`; the query
  text drives results (department names fail for e.g. "auto & tires"). Builds
  the daily tier lists; the store lookup confirms each item.
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
- **Bulk feeds** (`/paginated/items?category=&specialOffer=clearance|rollback|reduced`)
  are ~99% marketplace unless `soldByWmt=true`, which makes Walmart drop them
  (Home Clearance: 12,000+ listings -> 125). 200 items per page, `nextPage` to
  continue; rate-limited harder than other calls (wait ~60s on 429). They don't
  say whether an item is in stores; a lookup does (~73% of deal-feed items are
  online only).
- **Affiliate links**: Walmart's program runs on Impact. `productTrackingUrl`
  is `goto.walmart.com/c/{publisherId}/568844/9383?veh=aff&sourceid=imp_000011112222333344&u={item url}`
  (`|PUBID|` when no publisherId is sent); `walmartProductUrl` builds it.
- **SerpApi** (paid, now off via `useSerpApi`): `engine=walmart` with `store_id`
  and facets finds store clearance; `engine=walmart_product` with `store_id`
  adds aisle and pickup availability. 250 searches/month on the free plan.
- Walmart's `categoryPath` starts with "Home Page/"; the department is the next segment.
- `msrp` of 9999 is a placeholder, not a list price.
