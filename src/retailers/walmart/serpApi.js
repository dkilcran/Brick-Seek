// SerpApi's copy of walmart.com's product page (https://serpapi.com/walmart-product-api),
// used only to check whether an item is offered for pickup at a store when
// Walmart's own store lookup can't say (see CLAUDE.md). The free plan has 250
// searches a month, so callers keep a monthly budget.

export class SerpApiWalmart {
  /** @param {{ apiKey: string, fetchImpl?: typeof fetch }} opts */
  constructor({ apiKey, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Whether walmart.com offers pickup of an item at a store.
   * @returns {Promise<{ pickup: boolean|null, aisle: string|null, price: number|null }>} pickup null when the page doesn't say
   */
  async pickupAt(itemId, storeId) {
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({ engine: 'walmart_product', product_id: String(itemId), store_id: String(storeId), api_key: this.apiKey });
    const res = await this.fetchImpl(url);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`SerpApi: ${data.error ?? res.status}`);
    const p = data.product_result ?? {};
    return {
      pickup: typeof p.pickup_option?.available === 'boolean' ? p.pickup_option.available : null,
      aisle: p.pickup_option?.aisle ? String(p.pickup_option.aisle) : null, // e.g. "J4", when pickup is offered
      price: p.price_map?.price ?? null,
    };
  }
}
