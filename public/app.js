// Single-page UI. Talks only to the retailer-agnostic /api/:retailer/* routes.

const $app = document.getElementById('app');
const $zip = document.getElementById('zip-input');
const $banner = document.getElementById('mode-banner');

// localStorage can be unavailable (private mode, blocked storage).
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const state = {
  retailers: [],
  retailer: null,
  zip: storage.get('zip') ?? '',
};

const STATUS_LABEL = { in_stock: 'In stock', limited: 'Limited', out_of_stock: 'Out of stock', unknown: 'Check store' };

// ---------- helpers ----------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');
const pctOff = (price, msrp) => (price && msrp && msrp > price ? Math.round((1 - price / msrp) * 100) : 0);

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs) };
}

function go(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
  location.hash = qs ? `${path}?${qs}` : path;
}

function setZip(zip) {
  if (!/^\d{5}$/.test(zip)) return;
  state.zip = zip;
  $zip.value = zip;
  storage.set('zip', zip);
}

function initials(name) {
  return esc(name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
}

function thumb(product) {
  return `<div class="thumb">${product.imageUrl ? `<img src="${esc(product.imageUrl)}" alt="" loading="lazy">` : initials(product.brand ?? product.name)}</div>`;
}

function productCard(product, { zip, price = product.price, was = product.msrp, extra = '', note = '' } = {}) {
  const off = pctOff(price, was);
  const href = `#/r/${esc(product.retailer)}/item/${encodeURIComponent(product.id)}${zip ? `?zip=${zip}` : ''}`;
  return `<a class="card product-card" href="${href}">
    ${thumb(product)}
    <div class="name">${esc(product.name)}</div>
    <div class="price-row">
      <span class="price">${money(price)}</span>
      ${off ? `<span class="was">${money(was)}</span><span class="badge off">${off}% off</span>` : ''}
      ${extra}
    </div>
    ${note}
    ${product.onlineOnly ? '<div class="badges"><span class="badge signal">Online only</span></div>' : ''}
    <div class="muted" style="font-size:13px">Item #${esc(product.id)}${product.upc ? ` · UPC ${esc(product.upc)}` : ''}</div>
  </a>`;
}

function loading(msg = 'Loading…') { $app.innerHTML = `<div class="loading">${esc(msg)}</div>`; }
function showError(err) { $app.innerHTML = `<div class="error">${esc(err.message ?? err)}</div>`; }

function selectRetailer(id) {
  const r = state.retailers.find((x) => x.id === id) ?? state.retailers[0];
  state.retailer = r;
  document.documentElement.style.setProperty('--retailer', r.color);
  if (r.mode === 'demo') {
    $banner.hidden = false;
    $banner.textContent = `${r.name} is running on demo data: products, stores and stock levels are simulated. Configure API keys to go live.`;
  } else {
    $banner.hidden = true;
  }
  return r;
}

// ---------- views ----------
// Item numbers, UPCs and walmart.com links go straight to the product page.
const looksLikeItem = (text) => /walmart\.com\/ip\//i.test(text) || /^[\d\s-]{5,}$/.test(text.trim());

/** Product search: every Walmart item (online and in stores), 25 at a time. */
async function searchView(query) {
  const r = selectRetailer(query.get('retailer') ?? state.retailer?.id);
  const q = query.get('q') ?? '';
  const sort = query.get('sort') ?? 'best';
  $app.innerHTML = `
    <section class="hero"><h1>Search ${esc(r.name)} items</h1><p>Everything ${esc(r.name)} itself sells, online and in stores. Never marketplace sellers.</p></section>
    <form class="search-card" id="search-form">
      <div class="field"><label for="q">Product</label><input id="q" name="q" required value="${esc(q)}" placeholder="${esc(r.identifierHint)}"></div>
      <button class="btn" type="submit">Search</button>
    </form>
    <div id="results"></div>`;
  $app.querySelector('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    go('/search', { retailer: r.id, q: String(new FormData(e.target).get('q')).trim() });
  });
  if (!q) return;
  const $results = $app.querySelector('#results');
  $results.innerHTML = '<div class="loading">Searching…</div>';
  try {
    const loaded = [];
    const seen = new Set();
    let page = await api(`/api/${r.id}/search?q=${encodeURIComponent(q)}`);
    if (looksLikeItem(q) && page.products.length === 1) return go(`/r/${r.id}/item/${page.products[0].id}`, { zip: state.zip });
    const add = (products) => { for (const p of products) if (!seen.has(p.id)) { seen.add(p.id); loaded.push(p); } };
    add(page.products);
    if (!loaded.length) {
      $results.innerHTML = '<div class="empty">No products matched. Try a different name, item number or UPC.</div>';
      return;
    }
    $results.innerHTML = `<div class="section-title"><h2>Results for “${esc(q)}”</h2><span class="muted" id="found"></span></div>
      <form class="toolbar" id="search-sort">${sortSelect('ssort', sort, SORTS.filter(([v]) => v !== 'drop'))}</form>
      <div class="grid" id="result-grid"></div>
      <div style="text-align:center;margin-top:20px"><button class="btn secondary" id="more-results" type="button" hidden>Load more</button></div>`;
    const $grid = $results.querySelector('#result-grid');
    const $more = $results.querySelector('#more-results');
    const draw = () => {
      $grid.innerHTML = sortProducts(loaded, sort).map((p) => productCard(p, { zip: state.zip })).join('');
      $results.querySelector('#found').textContent = page.nextStart ? `Showing ${loaded.length} of about ${page.total}` : `${loaded.length} found`;
      $more.hidden = !page.nextStart;
    };
    draw();
    $results.querySelector('#search-sort').addEventListener('change', (e) => go('/search', { retailer: r.id, q, sort: e.target.value }));
    $more.addEventListener('click', async () => {
      $more.disabled = true;
      $more.textContent = 'Loading…';
      try {
        page = await api(`/api/${r.id}/search?q=${encodeURIComponent(q)}&start=${page.nextStart}`);
        add(page.products);
        draw();
      } catch (err) {
        $results.querySelector('#found').textContent = err.message;
      }
      $more.disabled = false;
      $more.textContent = 'Load more';
    });
  } catch (err) {
    $results.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

// Deal badges a list can be filtered by.
const BADGES = [
  ['clearance', 'Clearance'],
  ['rollback', 'Rollback'],
  ['reduced', 'Reduced Price'],
  ['markdown', 'Markdown'],
  ['drop', 'Price drop'],
  ['lowest', 'Lowest price ever'],
];

// Price range slider: 0-100 maps to $0-$2,000 on a curve with more room for low prices.
const PRICE_MAX = 2000;
const toPrice = (v) => (v >= 100 ? null : Math.round(PRICE_MAX * (v / 100) ** 3));
const toSlider = (price) => (price == null || price === '' ? 100 : Math.min(100, Math.round(100 * Math.cbrt(Number(price) / PRICE_MAX))));

/** One deal line: where, price, the reference price, and its badge. */
function dealLine(line, where) {
  if (!line) return '';
  const ref = where === 'Online' ? line.wasPrice : line.refPrice;
  const at = where === 'In store' && line.store
    ? `<div class="muted" style="font-size:12px">${esc(line.store.name ?? `Walmart #${line.store.id}`)}${line.storesWithDeal > 1 ? ` (+${line.storesWithDeal - 1} more stores)` : ''}${line.seenOn ? ` · checked ${esc(line.seenOn)}` : ''}</div>`
    : '';
  return `<div class="deal-line">
    <span class="deal-where">${where}</span>
    <span class="price">${money(line.price)}</span>
    ${ref > line.price ? `<span class="was">${money(ref)}</span>` : ''}
    ${line.label ? `<span class="badge ${badgeClass(line.label)} ${where === 'Online' ? 'outline' : ''}">${esc(line.label)} · ${where}</span>` : ''}
    ${line.percentOff ? `<span class="badge off">${line.percentOff}% off</span>` : ''}
    ${at}
  </div>`;
}

function allDealCard(c) {
  const href = `#/r/${esc(c.product.retailer)}/item/${encodeURIComponent(c.product.id)}${state.zip ? `?zip=${state.zip}` : ''}`;
  const extras = [
    c.dropPercent >= 1 ? `<span class="badge signal">Dropped ${c.dropPercent}%</span>` : '',
    c.atLowest ? '<span class="badge signal">Lowest price ever</span>' : '',
    !c.soldInStores ? '<span class="badge signal">Online only</span>' : '',
    !c.soldOnline ? '<span class="badge instore">Store only</span>' : '',
  ].filter(Boolean);
  return `<a class="card product-card" href="${href}">
    ${thumb(c.product)}
    <div class="name">${esc(c.product.name)}</div>
    ${dealLine(c.online, 'Online')}
    ${dealLine(c.store, 'In store')}
    ${extras.length ? `<div class="badges">${extras.join('')}</div>` : ''}
    <div class="muted" style="font-size:13px">Item #${esc(c.product.id)}</div>
  </a>`;
}

/**
 * The All Deals page (mode 'all') and the In Store Only page (mode 'stores',
 * items sold in stores). Filters live in the URL.
 */
async function allDealsView(mode, query) {
  const r = selectRetailer(query.get('retailer') ?? state.retailer?.id);
  const path = mode === 'stores' ? '/stores' : '/';
  const where = mode === 'stores' ? ['stores'] : (query.get('where') ?? 'online,stores').split(',').filter(Boolean);
  const labels = (query.get('labels') ?? '').split(',').filter(Boolean);
  const q = query.get('q') ?? '';
  const category = query.get('category') ?? '';
  const min = query.get('min') ?? '0';
  const sort = query.get('sort') ?? 'best';
  const minPrice = query.get('minPrice') ?? '';
  const maxPrice = query.get('maxPrice') ?? '';
  const params = (extra = {}) => {
    const out = { retailer: r.id, ...(mode === 'all' ? { where: where.join(',') } : {}), labels: labels.join(','), q, category, min, sort, minPrice, maxPrice, ...extra };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== '' && v != null));
  };
  const chip = ([id, label]) => {
    const next = new Set(labels);
    if (next.has(id)) next.delete(id); else next.add(id);
    return `<a class="chip ${labels.includes(id) ? 'active' : ''}" href="#${path}?${new URLSearchParams(params({ labels: [...next].join(',') }))}">${esc(label)}</a>`;
  };
  $app.innerHTML = `
    <section class="hero">
      <h1>${mode === 'stores' ? 'In Store Only' : 'All Deals'}</h1>
      <p>${mode === 'stores'
        ? `${esc(r.name)} items sold in stores, with their store deals and online deals.`
        : `Every deal ${esc(r.name)} itself has, online and at stores near you. Never marketplace sellers.`}</p>
    </section>
    <form class="toolbar deal-toolbar" id="deal-tools">
      <div class="field grow"><label for="dq">Search deals or look up an item</label>
        <div class="search-row"><input id="dq" name="q" type="search" value="${esc(q)}" placeholder="e.g. laptop, LEGO, or an item # / UPC / link">
        <button class="btn" type="submit">Search</button></div></div>
      ${mode === 'all' ? `<details class="field multi" id="where"><summary><span class="label">Where</span>${where.length === 2 ? 'Online and in stores' : where[0] === 'online' ? 'Sold Online' : 'Sold In Stores'}</summary>
        <label><input type="checkbox" name="where" value="online" ${where.includes('online') ? 'checked' : ''}> Sold Online</label>
        <label><input type="checkbox" name="where" value="stores" ${where.includes('stores') ? 'checked' : ''}> Sold In Stores</label>
      </details>` : ''}
      <div class="field"><label for="cat">Category</label><select id="cat" name="category"><option value="">All categories</option></select></div>
      <div class="field"><label for="min">Minimum discount</label><select id="min" name="min">
        ${[0, 10, 20, 30, 40, 50, 60].map((m) => `<option value="${m}" ${String(m) === min ? 'selected' : ''}>${m}%+</option>`).join('')}</select></div>
      ${sortSelect('sort', sort)}
      <div class="field price-range"><label>Price</label>
        <div class="range-row">
          <input type="number" name="minPrice" min="0" step="1" placeholder="$0" value="${esc(minPrice)}" aria-label="Minimum price">
          <div class="dual-range">
            <input type="range" id="lo" min="0" max="100" value="${minPrice === '' ? 0 : toSlider(minPrice)}" aria-label="Minimum price slider">
            <input type="range" id="hi" min="0" max="100" value="${toSlider(maxPrice === '' ? null : maxPrice)}" aria-label="Maximum price slider">
          </div>
          <input type="number" name="maxPrice" min="0" step="1" placeholder="Any" value="${esc(maxPrice)}" aria-label="Maximum price">
        </div>
      </div>
    </form>
    <div class="chips" style="justify-content:center">${BADGES.map(chip).join('')}</div>
    <div id="deal-list"><div class="loading">Loading deals…</div></div>`;

  const tools = $app.querySelector('#deal-tools');
  const apply = (extra = {}) => {
    const data = new FormData(tools);
    const w = mode === 'all' ? data.getAll('where') : where;
    go(path, params({
      ...(mode === 'all' ? { where: (w.length ? w : ['online', 'stores']).join(',') } : {}),
      q: String(data.get('q') ?? '').trim(), category: data.get('category'), min: data.get('min'), sort: data.get('sort'),
      minPrice: data.get('minPrice'), maxPrice: data.get('maxPrice'), ...extra,
    }));
  };
  tools.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = String(new FormData(tools).get('q') ?? '').trim();
    if (looksLikeItem(text)) return go('/search', { retailer: r.id, q: text });
    apply();
  });
  tools.addEventListener('change', (e) => {
    if (e.target.name === 'q' || e.target.type === 'range') return;
    apply();
  });
  // Sliders move the number boxes; letting go applies.
  const lo = tools.querySelector('#lo');
  const hi = tools.querySelector('#hi');
  const sync = () => {
    if (Number(lo.value) > Number(hi.value)) lo.value = hi.value;
    tools.elements.minPrice.value = Number(lo.value) > 0 ? toPrice(Number(lo.value)) : '';
    tools.elements.maxPrice.value = Number(hi.value) < 100 ? toPrice(Number(hi.value)) : '';
  };
  for (const el of [lo, hi]) {
    el.addEventListener('input', sync);
    el.addEventListener('change', () => { sync(); apply(); });
  }

  const $list = $app.querySelector('#deal-list');
  const PAGE = 60;
  const apiParams = new URLSearchParams({
    where: where.join(','), labels: labels.join(','), q, sort, minDiscount: min, limit: String(PAGE),
    ...(category ? { category } : {}), ...(minPrice !== '' ? { minPrice } : {}), ...(maxPrice !== '' ? { maxPrice } : {}),
    ...(state.zip ? { zip: state.zip } : {}),
  });
  const loadPage = (offset) => { apiParams.set('offset', String(offset)); return api(`/api/${r.id}/all-deals?${apiParams}`); };
  try {
    const first = await loadPage(0);
    tools.elements.category.innerHTML = `<option value="">All categories</option>${first.categories.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    const zipNote = state.zip ? '' : '<p class="muted" style="text-align:center">Store deals from every tracked store. Enter your ZIP at the top to see the stores nearest you.</p>';
    const searchAll = q ? `<p style="text-align:center"><a href="#/search?${new URLSearchParams({ retailer: r.id, q })}">Search all ${esc(r.name)} items for “${esc(q)}” →</a></p>` : '';
    if (!first.deals.length) {
      $list.innerHTML = `${zipNote}<div class="empty">No deals match those filters.</div>${searchAll}`;
      return;
    }
    $list.innerHTML = `${zipNote}<p class="muted" id="deal-count"></p><div class="grid" id="deal-grid"></div>
      <div style="text-align:center;margin-top:20px"><button class="btn secondary" id="load-more" type="button" hidden>Load more</button></div>${searchAll}`;
    const $grid = $list.querySelector('#deal-grid');
    const $more = $list.querySelector('#load-more');
    let shown = 0;
    const show = (page) => {
      $grid.insertAdjacentHTML('beforeend', page.deals.map(allDealCard).join(''));
      shown += page.deals.length;
      $list.querySelector('#deal-count').textContent = `Showing ${shown} of ${page.total} deals`;
      $more.hidden = !page.hasMore;
    };
    show(first);
    $more.addEventListener('click', async () => {
      $more.disabled = true;
      $more.textContent = 'Loading…';
      try { show(await loadPage(shown)); } catch (err) { $list.querySelector('#deal-count').textContent = err.message; }
      $more.disabled = false;
      $more.textContent = 'Load more';
    });
  } catch (err) {
    $list.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

function badgeClass(label) {
  if (label === 'Clearance') return 'clearance';
  if (/^(Rollback|Reduced Price)/.test(label)) return 'rollback';
  if (label === 'Markdown') return 'markdown';
  if (label === 'In-store only') return 'instore';
  return 'signal';
}

async function itemView(retailerId, id, query) {
  const r = selectRetailer(retailerId);
  const zip = query.get('zip') || state.zip;
  const radius = query.get('radius') ?? '50';
  const sort = query.get('sort') ?? 'distance';
  if (zip) setZip(zip);
  loading('Checking nearby stores…');

  let product;
  let inv = null;
  try {
    if (/^\d{5}$/.test(zip ?? '')) {
      inv = await api(`/api/${r.id}/products/${encodeURIComponent(id)}/inventory?zip=${zip}&radius=${radius}&sort=${sort}`);
      product = inv.product;
    } else {
      ({ product } = await api(`/api/${r.id}/products/${encodeURIComponent(id)}`));
    }
  } catch (err) {
    return showError(err);
  }

  const off = pctOff(product.price, product.msrp);
  $app.innerHTML = `
    <p><a href="#/?retailer=${esc(r.id)}">← New search</a></p>
    <div class="product-head">
      ${thumb(product)}
      <div>
        <h1>${esc(product.name)}</h1>
        <div class="meta">
          <span>${esc(r.name)} item #${esc(product.id)}</span>
          ${product.upc ? `<span>UPC ${esc(product.upc)}</span>` : ''}
          ${product.category ? `<span>${esc(product.category)}</span>` : ''}
        </div>
        <div class="price-row">
          <span class="price">${money(product.price)}</span><span class="muted">${product.storeOffers?.length ? 'at nearby stores' : 'online'}</span>
          ${product.inStockOnline === false ? '<span class="badge instore">In-store only</span>' : ''}
          ${product.onlineOnly ? '<span class="badge signal">Online only: not sold in stores</span>' : ''}
          ${off ? `<span class="was">${money(product.msrp)}</span><span class="badge off">${off}% off${product.storeOffers?.length ? '' : ' MSRP'}</span>` : ''}
        </div>
        ${product.onlineDeal ? dealLine(product.onlineDeal, 'Online')
          : product.storeOffers?.length ? `<div class="muted" style="font-size:14px">Online: ${product.onlinePrice != null
            ? `${money(product.onlinePrice)}${product.onlineSeller ? ` from ${esc(product.onlineSeller)}` : ''}`
            : `<a href="${esc(product.url)}" target="_blank" rel="noopener sponsored">see walmart.com</a>`}</div>` : ''}
        ${product.storeOffers?.length && !inv ? `<div class="card" style="margin:12px 0">
          <strong>In store, sold by ${esc(r.name)}</strong>
          ${product.storeOffers.map((o) => `<div class="price-row" style="margin-top:6px">
            <span class="price">${money(o.price)}</span>
            ${o.label && o.refPrice ? `<span class="was">${money(o.refPrice)}</span>` : ''}
            <span>${esc(o.storeLabel)}</span>
            ${o.label ? `<span class="badge ${badgeClass(o.label)}">${esc(o.label)}</span>` : ''}
            ${!o.label && o.wasPrice ? `<span class="muted" style="font-size:13px">Walmart "was" ${money(o.wasPrice)}</span>` : ''}
            ${o.inStock === false ? '<span class="badge out_of_stock">Out of stock</span>' : ''}
            <span class="muted" style="font-size:13px">scanned ${esc(o.seenOn)}</span>
          </div>`).join('')}
        </div>` : ''}
        <p><a href="${esc(product.url)}" target="_blank" rel="noopener sponsored">View on ${esc(r.name)}.com ↗</a></p>
      </div>
    </div>
    <div id="inventory"></div>
    ${r.features.priceHistory ? '<div class="section-title"><h2>Price history</h2><span class="muted">online price</span></div><div class="card" id="history"><div class="loading">Loading…</div></div>' : ''}`;

  const $inv = $app.querySelector('#inventory');
  if (!inv) {
    $inv.innerHTML = `<form class="card toolbar" id="zip-only" style="margin-top:20px">
      <div class="field"><label for="z2">Enter your ZIP to check local stores</label><input id="z2" name="zip" inputmode="numeric" maxlength="5" pattern="\\d{5}" required></div>
      <button class="btn" type="submit">Check stores</button></form>`;
    $inv.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      go(`/r/${r.id}/item/${product.id}`, { zip: new FormData(e.target).get('zip') });
    });
  } else {
    renderInventory($inv, r, product, inv, { radius, sort });
  }

  if (r.features.priceHistory) {
    try {
      const { history } = await api(`/api/${r.id}/products/${encodeURIComponent(id)}/history`);
      $app.querySelector('#history').innerHTML = priceChart(history);
    } catch (err) {
      $app.querySelector('#history').innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  }
}

function renderInventory($el, r, product, inv, { radius, sort }) {
  const s = inv.summary;
  const showQty = r.features.storeQuantities;
  // Walmart gives no store distances (the list is nearest first), so radius and distance only show when known.
  const hasDistance = inv.results.some((x) => x.store.distanceMiles != null);
  $el.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="label">Store prices</div><div class="value">${s.storesPriced ?? s.storesChecked} of ${s.storesChecked}</div></div>
      <div class="stat"><div class="label">In stock</div><div class="value" style="color:var(--ok)">${s.inStock + s.limited}</div></div>
      <div class="stat"><div class="label">Lowest price</div><div class="value">${money(s.lowestPrice)}</div></div>
      <div class="stat"><div class="label">Clearance stores</div><div class="value" style="color:var(--brand)">${s.clearanceStores}</div></div>
    </div>
    <div class="section-title"><h2>Stores near ${esc(inv.zip)}</h2><span class="muted">Checked ${new Date(inv.checkedAt).toLocaleTimeString()}</span></div>
    <form class="toolbar" id="inv-tools">
      ${hasDistance ? `<div class="field"><label for="r2">Radius</label><select id="r2" name="radius">${[10, 25, 50, 100].map((m) => `<option value="${m}" ${String(m) === String(radius) ? 'selected' : ''}>${m} mi</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="s2">Sort by</label><select id="s2" name="sort">
        <option value="distance" ${sort === 'distance' ? 'selected' : ''}>${hasDistance ? 'Distance' : 'Nearest first'}</option>
        <option value="price" ${sort === 'price' ? 'selected' : ''}>Lowest price</option></select></div>
      <div class="field"><label for="f2">Show</label><select id="f2" name="filter">
        <option value="all">All stores</option><option value="available">Available only</option></select></div>
      ${r.mode === 'live' ? '<div class="field"><label>&nbsp;</label><button class="btn" type="button" id="check-all">Check all stores</button></div>' : ''}
    </form>
    <div class="muted" id="check-progress" style="font-size:13px;min-height:18px"></div>
    <div id="store-table"></div>`;

  const drawTable = (filter) => {
    const rows = inv.results.filter((x) => filter !== 'available' || x.status === 'in_stock' || x.status === 'limited');
    $el.querySelector('#store-table').innerHTML = rows.length ? `<div class="table-scroll"><table>
      <thead><tr><th>Store</th><th class="hide-sm">Address</th>${hasDistance ? '<th>Distance</th>' : ''}<th>Price</th><th>Availability</th>${showQty ? '<th class="hide-sm">Aisle</th>' : ''}</tr></thead>
      <tbody>${rows.map((x) => `<tr>
        <td><div class="store-name">${esc(x.store.name)}</div>${x.store.phone ? `<div class="muted" style="font-size:13px">${esc(x.store.phone)}</div>` : ''}</td>
        <td class="hide-sm">${esc([x.store.address, x.store.city, x.store.state, x.store.zip].filter(Boolean).join(', '))}</td>
        ${hasDistance ? `<td class="num">${x.store.distanceMiles != null ? `${x.store.distanceMiles} mi` : '—'}</td>` : ''}
        <td class="num">${priceCell(x, product, r)}</td>
        <td><span class="badge ${esc(x.status)}">${STATUS_LABEL[x.status] ?? esc(x.status)}${showQty && x.quantity ? ` · ${x.quantity}` : ''}</span>${x.seenOn ? `<div class="muted" style="font-size:12px">Store price ${x.justChecked ? 'checked just now' : `scanned ${esc(x.seenOn)}`}</div>` : ''}${x.note ? `<div class="muted" style="font-size:12px">${esc(x.note)}</div>` : ''}</td>
        ${showQty ? `<td class="hide-sm">${esc(x.aisle ?? '—')}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty card">No stores match. Try a wider radius.</div>';
  };
  drawTable('all');
  const currentFilter = () => $el.querySelector('#f2').value;

  // "Check store": look the item up at that store now and update its row.
  const checkOne = async (storeId) => {
    const row = inv.results.find((x) => x.store.id === storeId);
    if (!row) return;
    row.checking = true;
    drawTable(currentFilter());
    try {
      const res = await api(`/api/${r.id}/products/${encodeURIComponent(product.id)}/check-store?store=${encodeURIComponent(storeId)}`);
      Object.assign(row, { price: res.price, status: res.status, clearance: Boolean(res.clearance), label: res.clearance ? 'Clearance' : null, wasPrice: res.wasPrice ?? null, seenOn: res.seenOn ?? row.seenOn, note: res.note ?? null, checked: res.price != null, justChecked: true });
    } catch (err) {
      row.note = err.message;
    }
    row.checking = false;
    drawTable(currentFilter());
  };
  $el.querySelector('#store-table').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-check-store]');
    if (btn) checkOne(btn.dataset.checkStore);
  });
  const $all = $el.querySelector('#check-all');
  $all?.addEventListener('click', async () => {
    $all.disabled = true;
    const stores = inv.results.map((x) => x.store.id);
    const $progress = $el.querySelector('#check-progress');
    for (const [i, id] of stores.entries()) {
      $progress.textContent = `Checking store ${i + 1} of ${stores.length}…`;
      await checkOne(id);
    }
    $progress.textContent = `Checked ${stores.length} stores.`;
    $all.disabled = false;
  });

  const tools = $el.querySelector('#inv-tools');
  tools.addEventListener('change', (e) => {
    if (e.target.name === 'filter') return drawTable(e.target.value);
    const data = new FormData(tools);
    go(`/r/${r.id}/item/${product.id}`, { zip: inv.zip, radius: data.get('radius') ?? radius, sort: data.get('sort') });
  });
}

function priceCell(x, product, r) {
  if (x.checking) return '<span class="muted">Checking…</span>';
  const check = (label) => (r.mode === 'live'
    ? `<button type="button" class="linkish" data-check-store="${esc(x.store.id)}">${label}</button>` : '');
  if (x.price == null) return check('Check store') || '—';
  const online = product.onlinePrice ?? (product.storeOffers?.length ? null : product.price);
  const label = x.label ?? (x.clearance ? 'Clearance' : null);
  return `<strong>${money(x.price)}</strong>${label ? ` <span class="badge ${badgeClass(label)}">${esc(label)}</span>` : ''}${online != null && x.price < online - 0.01 && !label ? ' <span class="badge off">Below online</span>' : ''}${!label && x.wasPrice ? `<div class="muted" style="font-size:12px">Walmart "was" ${money(x.wasPrice)}</div>` : ''}${x.checked ? `<div style="font-size:12px">${check('Recheck')}</div>` : ''}`;
}

function priceChart(history) {
  if (!history?.length) return '<div class="empty">No price history yet. We record prices each time this item is checked.</div>';
  const W = 800; const H = 220; const P = { l: 52, r: 12, t: 12, b: 26 };
  const prices = history.map((p) => p.price);
  let min = Math.min(...prices); let max = Math.max(...prices);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const x = (i) => P.l + (history.length === 1 ? 0 : (i / (history.length - 1)) * (W - P.l - P.r));
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  // step line: prices hold until they change
  let d = `M${x(0)},${y(prices[0])}`;
  for (let i = 1; i < prices.length; i++) d += ` H${x(i)} V${y(prices[i])}`;
  const area = `${d} V${H - P.b} H${x(0)} Z`;
  const ticks = [0, 0.5, 1].map((t) => min + (max - min) * t);
  const dates = [0, Math.floor((history.length - 1) / 2), history.length - 1];
  const low = Math.min(...prices); const high = Math.max(...prices);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price history">
      ${ticks.map((v) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">$${v.toFixed(0)}</text>`).join('')}
      <path class="area" d="${area}"/><path class="line" d="${d}"/>
      ${dates.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === history.length - 1 ? 'end' : 'middle'}">${esc(history[i].date)}</text>`).join('')}
    </svg>
    <div class="meta" style="margin:8px 0 0">
      <span>Low ${money(low)}</span><span>High ${money(high)}</span><span>Current ${money(prices[prices.length - 1])}</span>
    </div>`;
}

const SORTS = [
  ['best', 'Best match'],
  ['percent', '% off'],
  ['dollars', '$ off'],
  ['price', 'Price: low to high'],
  ['price-desc', 'Price: high to low'],
  ['drop', 'Biggest recent drop'],
];

function sortSelect(id, current, options = SORTS) {
  return `<div class="field"><label for="${id}">Sort by</label><select id="${id}" name="sort">
    ${options.map(([v, label]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>`;
}

/** Sort search results the same ways as the deal lists (discount against the shown was-price). */
function sortProducts(products, sort) {
  const off = (p) => (p.msrp > p.price ? p.msrp - p.price : 0);
  const pct = (p) => (p.msrp > p.price ? off(p) / p.msrp : 0);
  const by = {
    percent: (p) => -pct(p),
    dollars: (p) => -off(p),
    price: (p) => p.price ?? Infinity,
    'price-desc': (p) => -(p.price ?? -Infinity),
  }[sort];
  return by ? products.map((p, i) => [by(p), i, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]) : products;
}

// Deal types on the Deals page; pick any combination. The store ones need a ZIP.
// ---------- router ----------
async function render() {
  const { parts, query } = parseHash();
  const page = parts[0] === 'stores' ? 'stores' : parts[0] === 'search' || parts[0] === 'r' ? 'other' : 'all';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'stores') return await allDealsView('stores', query);
    if (parts[0] === 'search') return await searchView(query);
    if (parts[0] === 'r' && parts[2] === 'item' && parts[3]) return await itemView(parts[1], decodeURIComponent(parts[3]), query);
    // Old links: product search on the home page, and the old Deals page.
    if (!parts[0] && query.get('q')) return go('/search', Object.fromEntries(query));
    if (parts[0] === 'deals') return go('/', {});
    return await allDealsView('all', query);
  } catch (err) {
    showError(err);
  }
}

async function boot() {
  $zip.value = state.zip;
  document.getElementById('zip-form').addEventListener('submit', (e) => {
    e.preventDefault();
    setZip($zip.value.trim());
    render();
  });
  try {
    ({ retailers: state.retailers } = await api('/api/retailers'));
  } catch (err) {
    return showError(err);
  }
  if (!state.retailers.length) return showError('No retailers configured.');
  // Required disclosure once links carry affiliate tracking.
  const paid = state.retailers.filter((x) => x.features?.affiliateLinks).map((x) => x.name);
  if (paid.length) {
    document.getElementById('affiliate-note').textContent =
      `Clearance Tracker is independent and not run by ${paid.join(' or ')}. We may earn a commission when you buy through links on this site.`;
  }
  window.addEventListener('hashchange', render);
  render();
}

boot();
