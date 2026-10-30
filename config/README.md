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
| `searchTerms` | Words searched in each department; `clearance` finds marked-down items. |
| `monthlySearchBudget` | Searches allowed per calendar month. Match your SerpApi plan (the free plan is 100–250). The scan spreads this evenly over the month and stops at the limit. |

Each search covers one term in one department at one store and returns about
40 products. With 2 stores, 20 departments and 1 term, a full sweep is 40
searches; a budget of 100 covers every department at both stores about every
12 days.

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
