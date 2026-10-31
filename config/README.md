# Store scan settings

`store-scan.json` controls how the site finds markdowns at your nearby
Walmarts. Edit it on GitHub (open the file, click the pencil, commit); the
site redeploys and picks up the change. Check the result at
`/api/walmart/scan-config` on the live site, and daily progress at
`/api/walmart/store-check`.

Everything runs on Walmart's free affiliate API: its item lookup with a store
number returns that store's price, stock, Clearance flag and was-price.

## Daily schedule (Chicago time)

1. `schedule.productListAt` (04:00): refresh the product list (~20,000 items
   from Walmart's department, Clearance and Rollback lists, ~15 minutes). It is
   saved, so restarts don't redo it.
2. `schedule.storeChecksAt` (05:00): the store checks start, in order:
   - **discovery:** Walmart's search for each department with the `filters`
     (Clearance, sold by Walmart), up to `discoveryMaxPages` pages of 25;
   - **full checks:** every product-list and discovered item at the
     `dailyStores` plus `rotatingStoresPerDay` other stores;
   - **all stores:** everything found marked down is checked at every store.

## Settings

| Setting | Meaning |
| --- | --- |
| `zips` | ZIP codes the stores were chosen for (informational). |
| `schedule` | `productListAt` and `storeChecksAt`, as "HH:MM" in Chicago time. Store checks wait for the product-list refresh if it is still running. |
| `stores` | Walmart stores to track. `label` is just for you. Find store numbers at `/api/walmart/stores?zip=XXXXX&limit=50`. |
| `dailyStores` | Stores that get a full check of every item every day (home and work stores). |
| `rotatingStoresPerDay` | How many of the other stores also get a full check each day, taking turns (2 of the other 20 = each every 10 days). Each full check is about 1,000–1,400 free lookups (~35–50 minutes). |
| `departments` | Departments searched during discovery. Names must match the list below exactly. |
| `filters` | Walmart search filters for discovery. `special_offers:Clearance` = items Walmart marks Clearance; `retailer_type:Walmart` = sold by Walmart. Others: `special_offers:Rollback`, `special_offers:Reduced Price`. |
| `searchTerms` | Not used by the free discovery (each department's name is the search text). |
| `discoveryMaxPages` | Most search pages (25 items) per department. Busy departments like Home have hundreds of pages; this caps the daily work. |
| `restartChecks` | Change this to any new value to restart today's store checks right away with the current plan. |
| `useSerpApi` | `false`: SerpApi isn't used. `true` turns the old paid SerpApi store searches back on (needs `SERPAPI_KEY`), using `discoveryStores`, `maxPages`, `monthlySearchBudget`, `fullSweep` and `inspect`. |

## Departments

Walmart's top-level departments, as of October 2026. Ones marked † rarely
have shelf items worth scanning (services, online-only catalogs, themed
cross-listings of items already in other departments).

- Arts Crafts & Sewing
- Auto & Tires
- Baby
- Beauty
- Books †
- Cell Phones
- Clothing
- Collectibles †
- Electronics
- Food
- Health and Medicine
- Home
- Home Improvement
- Household Essentials
- Industrial & Scientific †
- Jewelry
- Kids
- Miscellaneous †
- Movies & TV Shows
- Music
- Musical Instruments
- Office Supplies
- Party & Occasions
- Patio & Garden
- Personal Care
- Pets
- Pharmacy †
- Premium Beauty
- Seasonal
- Shop by Movie †
- Shop by Seller †
- Shop by TV Show †
- Shop by Video Game †
- Shop with Purpose †
- Sports & Outdoors
- Subscriptions †
- Toys
- Video Games
- View In Your Home †
- Walmart for Business †
- Walmart MoneyCenter †
