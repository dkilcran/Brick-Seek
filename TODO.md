# To do

Everything from the Nov 2 list is done (deal labels, Markdown measurement,
product-page store list with Check store / Check all stores, department
filter, disk limits, affiliate links).

## Waiting on the owner

- Walmart affiliate approval on Impact, then set `WALMART_PUBLISHER_ID` in
  Render to turn on the tracking links and the disclosure.

## Open options (not started)

- **ZIP as a store limiter** in the top bar (deal pages limited to stores near
  it), noted Nov 5 as "at some point".
- **Store-brand feeds for Tier 3** (Mainstays, Great Value, Hyper Tough, Ozark
  Trail): ~28,000 more in-store items; deferred because national brands are
  more useful to compare.
- **New items each night** via the feeds' `lastDoc` (newer listings have
  higher item ids), instead of waiting for Monday's Tier 3 rebuild.
- **Store stock counts**: Walmart's API only says in stock or not; counts
  need another source (e.g. Walmart Data Ventures, paid).
