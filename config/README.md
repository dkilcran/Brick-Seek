# Store scan settings

`store-scan.json` controls how the site finds markdowns at your nearby
Walmarts. Edit it on GitHub (open the file, click the pencil, commit); the
site redeploys and picks up the change. Check the result at
`/api/walmart/scan-config` on the live site, and daily progress at
`/api/walmart/store-check`.

Everything runs on Walmart's free affiliate API: its search and deal feeds
build the item lists, and its item lookup with a store number returns that
store's price, stock, Clearance flag and was-price.

## Daily schedule (Chicago time)

Every step is one free call to Walmart (a search page, a feed page, or a
20-item lookup), paced by Walmart's rate limit (~28 calls a minute).

1. `schedule.productListAt` (04:00): build the **tier 1** (Clearance) and
   **tier 2** (Rollback, Reduced Price) lists with Walmart's search, for every
   department, limited by `baseFilters` (sold by Walmart, carried in stores),
   then Walmart's Clearance, Rollback and Reduced Price feeds (`dealFeeds`).
   Their items are the online deals on All Deals.
2. `schedule.storeChecksAt` (05:00), in order:
   1. tier 1 items at the full-check stores (`dailyStores` + rotating stores)
   2. tier 2 items at the full-check stores
   3. other items with a deal at some store (e.g. found through tier 3) at
      the full-check stores
   4. tier 1 + store-level deals (Walmart's Clearance flag at a store, or a
      **Markdown**, see below) at all other stores
   5. Walmart.com's own price and was-price for every deal item
3. With `nightlyNewItems`: each department's newest Walmart listings (its
   feed, sold by Walmart, after the newest item seen the night before) join
   the tier 3 list. Walmart numbers new listings above older ones; the first
   night finds where they start, so older listings aren't read.
4. On `schedule.tier3RebuildDay` (Monday): rebuild the **tier 3** list
   (everything sold by Walmart in stores in your departments) from department
   searches, every subcategory (`tier3Subcategories`) and the store-brand
   feeds (`tier3Brands`). Items from last week's list that a store check has
   seen on a shelf in the last 14 days are kept. If it isn't done by `endAt`
   it continues the next day.
5. Until `schedule.endAt` (20:00): the next tier 3 items at the `dailyStores`,
   continuing where the previous day stopped, so the whole list keeps cycling.

Steps 1-2 always finish, even past `endAt`. Walmart's search returns at most
1,000 results, so big searches are split into price bands ($1 minimum), and a
crowded $1 band is read sorted both ways.

## Settings

| Setting | Meaning |
| --- | --- |
| `zips` | ZIP codes the stores were chosen for (informational). |
| `schedule` | `productListAt`, `storeChecksAt`, `endAt` ("HH:MM", Chicago time) and `tier3RebuildDay` (a weekday). |
| `stores` | Walmart stores to track. `label` is just for you. Find store numbers at `/api/walmart/stores?zip=XXXXX&limit=50`. |
| `dailyStores` | Full checks every day, and tier 3 slices (home and work stores). |
| `rotatingStoresPerDay` | How many of the other stores also get the full checks each day, taking turns. |
| `departments` | Departments searched for the tier lists. Names must match the list below. |
| `departmentQueries` | Search words per department (Walmart's search needs text). Departments not listed use their own name. |
| `baseFilters` | Filters on every search: `retailer_type:Walmart` (sold by Walmart), `fulfillment_method:In-store` (carried in stores). |
| `tiers` | The deal filters for tier 1 (`"1"`) and tier 2 (`"2"`); each filter is its own search pass. |
| `tier3Subcategories` | `true` (default): the weekly Tier 3 rebuild also searches every Walmart subcategory of your departments by its own name, limited to that subcategory (in stores, sold by Walmart). About 900 subcategories, ~4,200 searches; it continues the next day if unfinished. `false` turns it off. |
| `tier3Brands` | Brands whose Walmart feeds (sold by Walmart, per department) join the weekly Tier 3 rebuild. Default: Walmart's own brands Mainstays, Great Value, Hyper Tough, Ozark Trail. `[]` turns it off. Walmart's brand filter is loose, so some other brands come along. |
| `nightlyNewItems` | `true` (default): each night after the store checks, add each department's newest Walmart listings to Tier 3. `false` turns it off. |
| `dealFeeds` | `true` (default): after the morning search, also read Walmart's Clearance, Rollback and Reduced Price feeds (sold by Walmart only) into the lists. `false` turns them off. |
| `markdownPercent` | A store price at least this many percent below the item's highest valid store price (current, sold by Walmart, at any store, or that store's own earlier price) is labeled **Markdown**. Default 10. |
| `restartChecks` | Change this to any new value to restart today's cycle right away. |

## Deal labels

Each store price gets at most one label, in this order:

1. **Clearance**: Walmart's Clearance flag at that store.
2. **Rollback** / **Reduced Price**: on today's Walmart Rollback or Reduced
   Price list (tier 2), with a was-price at that store.
3. **Markdown** (ours): at least `markdownPercent` below the item's highest
   valid store price: the highest current Walmart-sold price at any store, or
   that store's own earlier price if higher. A store price above the item's
   list price (Walmart's MSRP, or the highest was-price at any store) isn't
   valid, and Walmart's own online price caps the reference.

A store price above Walmart's own online price gets no label: it's cheaper
online. Walmart's online price comes from the daily searches (Walmart-sold
items only) and, for deal items the searches missed, a daily online lookup
that only keeps prices where Walmart is the online seller.

A was-price alone is not a deal (Walmart shows "was" prices on items with no
offer); the page shows it as information only. Walmart's offers are measured
against its was-price (or the highest store price when there's none);
Markdowns against the highest valid store price.

Progress: `/api/walmart/store-check`.

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
