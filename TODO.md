# To do

Ideas and fixes waiting to be worked on. Nothing here has been started.

## From the owner (Nov 2, 2026)

1. **Where does the Clearance tag come from?** Explain the source of the
   Clearance label on deals and store prices.
2. **A "Markdown" label** for items that Walmart hasn't already labeled
   Clearance, Rollback or Reduced Price.
3. **Measure markdowns accurately** by comparing against other stores AND a
   was-price or MSRP. Some "Clearance near you" items have an unrealistic MSRP
   (possibly a competitor's price) but a reasonable price that's the same at
   every store, so they're probably not clearance.
4. **Store list on the product page:**
   - Don't show the online price for each store by default; it's an
     ambiguous guess. Still show the online price somewhere on the page.
   - A "Check store" link per store that looks up that store's data and
     updates the price when it can.
   - A "Check all stores" button that checks every store listed on the page
     and updates the prices.
5. **Affiliate program:** how to set up affiliate links so clicks through to
   Walmart earn commission.

## Found while checking the site (Nov 2, 2026)

6. **Department filter:** about 1,800 of the 5,431 "Clearance near you" items
   are in removed departments (Clothing 774, Beauty 271, Pets 204, Health and
   Medicine 198, Baby 183, Personal Care 159), plus some Books and
   Collectibles. Show only the departments in `config/store-scan.json`, and
   skip the others in the Tier 3 store checks.
7. **Disk space:** the database grew from 143 MB to 222 MB in two days. Check
   that the Render disk has room for about 600–700 MB, the expected size once
   14-day retention levels it off.
