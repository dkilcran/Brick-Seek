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

const UPCOMING = ['Target', 'Home Depot', "Lowe's", 'Best Buy'];
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
    <div class="muted" style="font-size:13px">Item #${esc(product.id)}${product.upc ? ` · UPC ${esc(product.upc)}` : ''}</div>
  </a>`;
}

function loading(msg = 'Loading…') { $app.innerHTML = `<div class="loading">${esc(msg)}</div>`; }
function showError(err) { $app.innerHTML = `<div class="error">${esc(err.message ?? err)}</div>`; }

function retailerTabs(active) {
  return `<div class="retailer-tabs">
    ${state.retailers.map((r) => `<button type="button" class="retailer-tab ${r.id === active ? 'active' : ''}" data-retailer="${esc(r.id)}" style="--retailer:${esc(r.color)}">${esc(r.name)}</button>`).join('')}
    ${UPCOMING.map((n) => `<span class="retailer-tab soon" title="Coming soon">${esc(n)}</span>`).join('')}
  </div>`;
}

function bindRetailerTabs(onPick) {
  $app.querySelectorAll('[data-retailer]').forEach((btn) =>
    btn.addEventListener('click', () => onPick(btn.dataset.retailer)));
}

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
async function homeView(query) {
  const r = selectRetailer(query.get('retailer') ?? state.retailer?.id);
  const q = query.get('q') ?? '';
  $app.innerHTML = `
    <section class="hero">
      <h1>Find it in stock, nearby, for less.</h1>
      <p>Check store-by-store availability and in-store prices, including hidden clearance.</p>
    </section>
    ${retailerTabs(r.id)}
    <form class="search-card" id="search-form">
      <div class="field"><label for="q">Product</label><input id="q" name="q" required value="${esc(q)}" placeholder="${esc(r.identifierHint)}"></div>
      <div class="field"><label for="zip">ZIP code</label><input id="zip" name="zip" inputmode="numeric" maxlength="5" pattern="\\d{5}" value="${esc(state.zip)}" placeholder="12345"></div>
      <div class="field"><label for="radius">Radius</label>
        <select id="radius" name="radius">${[10, 25, 50, 100].map((m) => `<option value="${m}" ${m === 50 ? 'selected' : ''}>${m} mi</option>`).join('')}</select>
      </div>
      <button class="btn" type="submit">Check stock</button>
    </form>
    <div id="results"></div>
    <div id="home-deals"></div>
    ${q ? '' : `<div class="how">
      <div class="card"><h3>1. Find the product</h3><p>Paste an item number, UPC from the barcode, a product link, or just search by name.</p></div>
      <div class="card"><h3>2. Enter your ZIP</h3><p>We check every nearby store and show stock and the price on the shelf.</p></div>
      <div class="card"><h3>3. Grab the deal</h3><p>Stores that marked an item down to clearance show up at the top when you sort by price.</p></div>
    </div>`}`;

  bindRetailerTabs((id) => go('/', { retailer: id, q }));
  const form = $app.querySelector('#search-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const zip = String(data.get('zip') ?? '');
    if (zip) setZip(zip);
    const text = String(data.get('q')).trim();
    // Direct identifiers jump straight to the inventory page.
    try {
      const res = await api(`/api/${r.id}/search?q=${encodeURIComponent(text)}`);
      if (res.products.length === 1 && text.replace(/\D/g, '').length >= 5) {
        return go(`/r/${r.id}/item/${res.products[0].id}`, { zip: state.zip, radius: data.get('radius') });
      }
    } catch { /* fall through to results view */ }
    go('/', { retailer: r.id, q: text });
  });

  if (q) {
    const $results = $app.querySelector('#results');
    $results.innerHTML = '<div class="loading">Searching…</div>';
    try {
      // 25 at a time; "Load more" fetches the next page until every result is shown.
      const sort = query.get('sort') ?? 'best';
      const loaded = [];
      const seen = new Set();
      let page = await api(`/api/${r.id}/search?q=${encodeURIComponent(q)}`);
      const add = (products) => { for (const p of products) if (!seen.has(p.id)) { seen.add(p.id); loaded.push(p); } };
      add(page.products);
      if (!loaded.length) {
        $results.innerHTML = '<div class="empty">No products matched. Try a different name, item number or UPC.</div>';
        return;
      }
      $results.innerHTML = `<div class="section-title"><h2>Results for “${esc(q)}”</h2><span class="muted" id="found"></span></div>
        <form class="toolbar" id="search-sort">${sortSelect('ssort', sort)}</form>
        <div class="grid" id="result-grid"></div>
        <div style="text-align:center;margin-top:20px"><button class="btn secondary" id="more-results" type="button" hidden>Load more</button></div>`;
      const $grid = $results.querySelector('#result-grid');
      const $more = $results.querySelector('#more-results');
      const draw = () => {
        // Sorting applies to everything loaded so far.
        $grid.innerHTML = sortProducts(loaded, sort).map((p) => productCard(p, { zip: state.zip })).join('');
        $results.querySelector('#found').textContent = page.nextStart
          ? `Showing ${loaded.length} of about ${page.total}` : `${loaded.length} found`;
        $more.hidden = !page.nextStart;
      };
      draw();
      $results.querySelector('#search-sort').addEventListener('change', (e) => go('/', { retailer: r.id, q, sort: e.target.value }));
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
  } else if (r.features.deals) {
    await renderHomeDeals(r, query.get('cat') ?? '');
  }
}

async function renderHomeDeals(r, category) {
  const $deals = $app.querySelector('#home-deals');
  let categories = [];
  try { ({ categories } = await api(`/api/${r.id}/categories`)); } catch { /* chips are optional */ }
  const params = new URLSearchParams();
  if (state.zip) params.set('zip', state.zip);
  if (category) params.set('category', category);
  let sections;
  try {
    ({ sections } = await api(`/api/${r.id}/deals/sections?${params}`));
  } catch {
    return; // deals are optional on the home page
  }
  const chip = (value, label) =>
    `<a class="chip ${value === category ? 'active' : ''}" href="#/?${new URLSearchParams({ retailer: r.id, ...(value ? { cat: value } : {}) })}">${esc(label)}</a>`;
  $deals.innerHTML = `
    ${categories.length ? `<div class="chips">${chip('', 'All categories')}${categories.map((c) => chip(c, c)).join('')}</div>` : ''}
    ${sections.map((sec) => dealSection(r, sec, category)).join('')}`;
}

function dealSection(r, sec, category) {
  if (!sec.deals.length && !sec.note) return '';
  const all = new URLSearchParams({ retailer: r.id, section: sec.id, ...(category ? { category } : {}) });
  return `<section class="deal-section">
    <div class="section-title">
      <div><h2>${esc(sec.title)}</h2><div class="muted" style="font-size:14px">${esc(sec.description)}</div></div>
      ${sec.deals.length ? `<a href="#/deals?${all}">See all →</a>` : ''}
    </div>
    ${sec.deals.length ? `<div class="grid">${sec.deals.map(dealCard).join('')}</div>` : `<div class="card empty">${esc(sec.note)}</div>`}
  </section>`;
}

/** Badge style for a deal label or reason. */
function badgeClass(label) {
  if (label === 'Clearance') return 'clearance';
  if (/^(Rollback|Reduced Price)/.test(label)) return 'rollback';
  if (label === 'Markdown') return 'off';
  if (label === 'In-store only') return 'instore';
  return 'signal';
}

function dealCard(d) {
  const badges = (d.reasons ?? []).map((reason) =>
    `<span class="badge ${badgeClass(reason)}">${esc(reason)}</span>`);
  const savings = d.dollarsOff >= 1
    ? `<span class="muted" style="font-size:13px">Save ${money(d.dollarsOff)}${d.onlineSeller ? ' vs other sellers online' : ''}</span>`
    : '';
  const store = d.store
    ? `<div style="font-size:13px"><strong>${esc(d.store.name)}</strong>${d.store.distanceMiles != null ? ` · ${d.store.distanceMiles} mi` : ''}${d.quantity != null ? ` · ${d.quantity} left` : ''}${d.storesWithDeal > 1 ? ` · ${d.storesWithDeal} stores` : ''}${d.store.seenOn ? ` · scanned ${esc(d.store.seenOn)}` : ''}</div>`
    : '';
  return productCard(d.product, {
    zip: state.zip,
    price: d.lowestPrice,
    was: d.referencePrice ?? d.product.msrp,
    extra: savings,
    note: `${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}${store}`,
  });
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
          ${off ? `<span class="was">${money(product.msrp)}</span><span class="badge off">${off}% off${product.storeOffers?.length ? '' : ' MSRP'}</span>` : ''}
        </div>
        ${product.storeOffers?.length ? `<div class="muted" style="font-size:14px">Online: ${product.onlinePrice != null
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
];

function sortSelect(id, current) {
  return `<div class="field"><label for="${id}">Sort by</label><select id="${id}" name="sort">
    ${SORTS.map(([v, label]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>`;
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
const DEAL_TYPES = [
  ['top', 'Top deals'],
  ['drops', 'Price drops'],
  ['lowest', 'Lowest ever'],
  ['bigticket', 'Big-ticket'],
];
const STORE_DEAL_TYPES = [
  ['store-clearance', 'Clearance'],
  ['store-rollback', 'Rollback'],
  ['store-reduced', 'Reduced Price'],
  ['store-markdown', 'Markdown'],
];

async function dealsView(query) {
  const r = selectRetailer(query.get('retailer') ?? state.retailer?.id);
  // "clearance" (all store deals, e.g. from the home page) means every store type.
  const picked = new Set((query.get('section') ?? 'top').split(',').flatMap((s) => (s === 'clearance' ? STORE_DEAL_TYPES.map(([id]) => id) : [s])));
  const types = [...DEAL_TYPES, ...(r.features.localClearance ? STORE_DEAL_TYPES : [])];
  for (const id of picked) if (!types.some(([t]) => t === id)) picked.delete(id);
  if (!picked.size) picked.add('top');
  const category = query.get('category') ?? '';
  const min = query.get('min') ?? '0';
  const sort = query.get('sort') ?? 'best';
  const text = query.get('q') ?? '';
  loading('Finding deals…');
  let categories = [];
  try { ({ categories } = await api(`/api/${r.id}/categories`)); } catch { /* optional */ }

  const params = (extra) => ({ retailer: r.id, section: [...picked].join(','), ...(category ? { category } : {}), min, sort, ...(text ? { q: text } : {}), ...extra });
  // Each chip toggles its type on or off (at least one stays on).
  const chip = ([id, label]) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    const href = next.size ? `#/deals?${new URLSearchParams(params({ section: [...next].join(',') }))}` : '';
    return `<a class="chip ${picked.has(id) ? 'active' : ''}" ${href ? `href="${href}"` : ''} aria-pressed="${picked.has(id)}">${esc(label)}</a>`;
  };
  $app.innerHTML = `
    <section class="hero"><h1>${esc(r.name)} deals</h1><p>Only items sold by ${esc(r.name)} itself, never marketplace sellers. Pick any combination of deal types.</p></section>
    ${retailerTabs(r.id)}
    <div class="chips" style="justify-content:center">${DEAL_TYPES.map(chip).join('')}</div>
    ${r.features.localClearance ? `<div class="chips" style="justify-content:center"><span class="muted" style="align-self:center;font-size:13px">At stores near you:</span>${STORE_DEAL_TYPES.map(chip).join('')}</div>` : ''}
    <form class="toolbar" id="deal-tools" style="justify-content:center">
      <div class="field"><label for="dq">Search deals</label><input id="dq" name="q" type="search" value="${esc(text)}" placeholder="e.g. laptop, LEGO, coffee"></div>
      <div class="field"><label for="cat">Category</label><select id="cat" name="category"><option value="">All categories</option>
        ${categories.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label for="min">Minimum discount</label><select id="min" name="min">
        ${[0, 10, 20, 30, 40, 50, 60].map((m) => `<option value="${m}" ${String(m) === min ? 'selected' : ''}>${m}%+</option>`).join('')}</select></div>
      ${sortSelect('sort', sort)}
    </form>
    <div id="deal-list"><div class="loading">Loading…</div></div>`;

  bindRetailerTabs((id) => go('/deals', { retailer: id }));
  const tools = $app.querySelector('#deal-tools');
  const apply = () => {
    const data = new FormData(tools);
    go('/deals', params({ category: data.get('category'), min: data.get('min'), sort: data.get('sort'), q: String(data.get('q') ?? '').trim() }));
  };
  tools.addEventListener('change', (e) => { if (e.target.name !== 'q') apply(); });
  tools.addEventListener('submit', (e) => { e.preventDefault(); apply(); });

  const $list = $app.querySelector('#deal-list');
  // Store deal types need a ZIP; without one, only the online types are listed.
  let sections = [...picked];
  let zipNote = '';
  if (!state.zip && sections.some((s) => s.startsWith('store-'))) {
    sections = sections.filter((s) => !s.startsWith('store-'));
    zipNote = '<div class="card empty">Enter your ZIP code at the top of the page to see deals at nearby stores.</div>';
    if (!sections.length) {
      $list.innerHTML = zipNote;
      return;
    }
  }
  // Every match, best first, 60 at a time.
  const PAGE = 60;
  const query2 = new URLSearchParams({ section: sections.join(','), minDiscount: min, limit: String(PAGE), sort });
  if (category) query2.set('category', category);
  if (text) query2.set('q', text);
  if (state.zip) query2.set('zip', state.zip);
  const loadPage = async (offset) => {
    query2.set('offset', String(offset));
    return api(`/api/${r.id}/deals?${query2}`);
  };
  try {
    const first = await loadPage(0);
    if (!first.deals.length) {
      $list.innerHTML = '<div class="empty">No deals match those filters yet. Price drop and lowest-ever deals appear as the app records prices day to day.</div>';
      return;
    }
    $list.innerHTML = `${zipNote}<p class="muted" id="deal-count"></p><div class="grid" id="deal-grid"></div>
      <div style="text-align:center;margin-top:20px"><button class="btn secondary" id="load-more" type="button" hidden>Load more</button></div>`;
    const $grid = $list.querySelector('#deal-grid');
    const $more = $list.querySelector('#load-more');
    const $count = $list.querySelector('#deal-count');
    let shown = 0;
    const show = (page) => {
      $grid.insertAdjacentHTML('beforeend', page.deals.map(dealCard).join(''));
      shown += page.deals.length;
      $count.textContent = `Showing ${shown} of ${page.total} deals`;
      $more.hidden = !page.hasMore;
    };
    show(first);
    $more.addEventListener('click', async () => {
      $more.disabled = true;
      $more.textContent = 'Loading…';
      try {
        show(await loadPage(shown));
      } catch (err) {
        $count.textContent = err.message;
      }
      $more.disabled = false;
      $more.textContent = 'Load more';
    });
  } catch (err) {
    $list.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}

// ---------- router ----------
async function render() {
  const { parts, query } = parseHash();
  document.querySelectorAll('[data-nav]').forEach((a) =>
    a.classList.toggle('active', a.dataset.nav === (parts[0] === 'deals' ? 'deals' : 'home')));
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'deals') return await dealsView(query);
    if (parts[0] === 'r' && parts[2] === 'item' && parts[3]) return await itemView(parts[1], decodeURIComponent(parts[3]), query);
    return await homeView(query);
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
