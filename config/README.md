# Store scan settings

`store-scan.json` controls the local store scan (store-level prices from
SerpApi). Edit it on GitHub (open the file, click the pencil, commit); the
site redeploys and picks up the change. Check the result at
`/api/walmart/scan-config` on the live site: it lists any department names it
doesn't recognize and how often each department gets scanned.

| Setting | Meaning |
| --- | --- |
| `zips` | ZIP codes the stores were chosen for (informational). |
| `stores` | Walmart stores to track. Prices, stock, Clearance flags and was-prices are checked at all of them for free through Walmart's item lookup (no SerpApi searches). `label` is just for you. Find store numbers at `/api/walmart/stores?zip=XXXXX&limit=50`. |
| `discoveryStores` | The stores SerpApi searches to *find* clearance items (Walmart's free bulk lists ignore stores). Every item found is then checked at all `stores` for free. Defaults to all stores. |
| `maxPages` | How many result pages (40 items each) to search per department; pages past a department's last page are skipped. |
| `departments` | Departments to search at each store. Names must match the list below exactly. |
| `filters` | Walmart's own search filters. `special_offers:Clearance` = items Walmart marks Clearance; `retailer_type:Walmart` = sold by Walmart (no marketplace sellers). Other examples: `special_offers:Rollback`, `special_offers:Reduced Price`. |
| `searchTerms` | Optional keywords searched within each department, on top of the filters. Leave empty (`[]`) to list everything the filters match. Each term multiplies the searches per sweep. |
| `fullSweep` | Change this to any new value (today's date works) to scan every store and department once, right away, instead of waiting for the schedule. Each sweep uses one search per store × department (28 now). |
| `monthlySearchBudget` | Searches allowed per calendar month. Match your SerpApi plan (the free plan is 100–250). The scan spreads this evenly over the month and stops at the limit. |

Each SerpApi search covers one results page of one department at one
discovery store and returns about 40 products. With 2 discovery stores, 14
departments and up to 5 pages, a full pass is at most 140 searches (fewer when
departments have fewer pages). Store checks are separate and free: each day
every tracked item is checked at one store (rotating through all stores), and
everything found marked down is checked at every store. Progress:
`/api/walmart/store-check`. Searches cluster on Wednesday/Thursday mornings and the first
week of the month, when Walmart most often marks prices down.

Whenever these settings change, the scan runs one search right away to check
they work; `/api/walmart/store-scan` shows how it went (`lastRunSummary`).

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
