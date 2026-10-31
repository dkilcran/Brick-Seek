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
  (e.g. `special_offers:Clearance` and `retailer_type:Walmart`), 25 per page,
  paged with `start`. It ignores `storeId` and `categoryId`; the query text
  drives results. Used for daily discovery; the store lookup confirms each item.
- `storeId` on `/items` is undocumented (docs list only `ids`, `upc`,
  `publisherId`), so it could change without notice.
- **SerpApi** (paid, now off via `useSerpApi`): `engine=walmart` with `store_id`
  and facets finds store clearance; `engine=walmart_product` with `store_id`
  adds aisle and pickup availability. 250 searches/month on the free plan.
- Walmart's `categoryPath` starts with "Home Page/"; the department is the next segment.
- `msrp` of 9999 is a placeholder, not a list price.
