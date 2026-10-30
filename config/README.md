# Store scan settings

`store-scan.json` controls the local store scan (store-level prices from
SerpApi). Edit it on GitHub (open the file, click the pencil, commit); the
site redeploys and picks up the change. Check the result at
`/api/walmart/scan-config` on the live site: it lists any department names it
doesn't recognize and how often each department gets scanned.

| Setting | Meaning |
| --- | --- |
| `zip` | ZIP code the stores were chosen for (informational). |
| `stores` | Walmart store numbers to scan. `label` is just for you. Find store numbers at `/api/walmart/stores?zip=XXXXX`. |
| `departments` | Departments to search at each store. Names must match the list below exactly. |
| `filters` | Walmart's own search filters. `special_offers:Clearance` = items Walmart marks Clearance; `retailer_type:Walmart` = sold by Walmart (no marketplace sellers). Other examples: `special_offers:Rollback`, `special_offers:Reduced Price`. |
| `searchTerms` | Optional keywords searched within each department, on top of the filters. Leave empty (`[]`) to list everything the filters match. Each term multiplies the searches per sweep. |
| `monthlySearchBudget` | Searches allowed per calendar month. Match your SerpApi plan (the free plan is 100–250). The scan spreads this evenly over the month and stops at the limit. |

Each search covers one department at one store (and one term, if any) and
returns about 40 products. With 2 stores and 14 departments a full sweep is 28
searches; a budget of 250 covers every department at both stores roughly 9
times a month. Searches cluster on Wednesday/Thursday mornings and the first
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
