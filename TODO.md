# To do

## Handoff (Nov 21, 2026): read this first in a new session

The previous session got long, so work continues in a new one. Everything it
learned is in `CLAUDE.md` (data-source notes), `config/README.md` (schedule,
settings, deal-label rules) and the code. Live state on Nov 21, 18:50 UTC:

- **Daily cycle was stuck Nov 20-21.** From Nov 20 Walmart refuses some item
  lookups with 400 "The items that you're trying to access are excluded from
  our API" (code 4035), and one refused id failed its whole 20-item batch,
  retried every minute. Fixed (`lookupItems` in `liveSource.js` splits a
  refused batch and skips refused ids); Nov 20's checks resumed at segment 3
  of 5 and run slowly while refused ids are found (first 2 minutes: 40 of 60
  requests refused, 27 refused ids). Nov 21's cycle starts after they finish.
- **Next fixes (start here):**
  1. Check `/api/walmart/store-check`: `day`, `phase`, `lastError`, and
     `walmartLastHour` (requests, `rateLimited`, `refused`,
     `refusedIdsSkipped`). The cycle should reach `done` and a new `day`.
  2. Refused ids are remembered in memory only, so every deploy relearns them
     at ~8 extra requests each. Save them in the database (e.g. a
     `store_items` flag) and leave them out of the tier lists and store checks.
  3. Find out which items Walmart excludes (a category or brand?) and note it
     in `CLAUDE.md`.
- **Unconfirmed store answers (Nov 19-20):** store answers identical to the
  online lookup are saved `confirmed = 0` and shown "not confirmed in store";
  "Check store" on one such row asks SerpApi about pickup (150 a month,
  3 used). Watch Tier 3 throughput: store checks now do one online lookup per
  20 items first.
- **Weekly Tier 3 rebuild** (Mondays): the first with subcategories ran Nov
  16-17 (68,542 items incl. ~14,350 brand-feed items being dropped as Walmart
  doesn't know them; 47,560 on Nov 21). Brand feeds are off; a Tier 3 search
  now stops at a page with nothing new.
- **Nightly new listings**: worked Nov 17 (47 added); confirm `newItems.added`
  stays above 0 most nights.
- Tools: `scripts/perf.mjs` (time queries at production size) and
  `scripts/boot-test.sh [commit]` (boot on an older commit's database).

### The Monday check-in: ask the owner whether to set it up again

The previous session had a scheduled check-in for **Monday Nov 23, 8:15pm
Chicago** (after the 8pm end of the day's checks). It was removed with the
handoff, because it would have woken the old session.

- **What it did:** read `/api/walmart/store-check` and reported: did the
  weekly Tier 3 rebuild finish that day (`tier3.lastBuild.finishedAt`, its
  `items` vs last week's 68,542, `carriedOver`), or how far it got
  (`tier3.rebuilding`: queued, found); whether Tier 3 store lookups resumed;
  `newItems.added`; `lastError`; and whether the morning checks finished on
  time. Fix bugs if found, then report briefly.
- **Why:** it's the second rebuild, the first with "a search page that finds
  nothing new ends that search" and with brand feeds off. The first rebuild
  ran two days and paused Tier 3 store checks meanwhile; this one should
  finish Monday.
- **Ask the owner** whether to set it up again, and how: wake this session
  (its report lands in the conversation), or start a fresh session each time
  that writes its report to a `STATUS.md` on a separate `status` branch
  (Render deploys only `main`, so no restart) for the main session to read.

## Waiting on the owner

- Walmart affiliate approval on Impact, then set `WALMART_PUBLISHER_ID` in
  Render to turn on the tracking links and the disclosure.

## Open options (not started)

- **ZIP as a store limiter** in the top bar (deal pages limited to stores near
  it), noted Nov 5 as "at some point".
- **Store stock counts**: neither Walmart's API nor SerpApi gives them
  (SerpApi's `max_quantity` is the order limit); SerpApi gives the aisle with
  pickup, now shown. Counts need another source (e.g. Walmart Data Ventures, paid).
