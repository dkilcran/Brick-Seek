// Parse whatever a user pastes into the search box into a Walmart identifier.
//   https://www.walmart.com/ip/Some-Product-Name/123456789  -> itemId
//   012345678905 (12-digit UPC) / 13/14-digit GTIN            -> upc
//   123456789 (6-11 digits)                                    -> itemId
//   anything else                                              -> keyword query

export function parseWalmartInput(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return { type: 'empty', value: '' };

  const urlMatch = input.match(/walmart\.com\/(?:ip\/(?:[^/?#]+\/)?|.*[?&]itemId=)(\d{5,12})/i);
  if (urlMatch) return { type: 'itemId', value: urlMatch[1] };

  const digits = input.replace(/[\s-]/g, '');
  if (/^\d+$/.test(digits)) {
    if (digits.length >= 12 && digits.length <= 14) return { type: 'upc', value: digits };
    if (digits.length >= 5 && digits.length <= 11) return { type: 'itemId', value: digits };
  }
  return { type: 'query', value: input };
}

/**
 * Link to an item on walmart.com. With an Impact publisher ID (Walmart's
 * affiliate program), it's Walmart's tracking link, in the exact form
 * Walmart's API returns as productTrackingUrl:
 * goto.walmart.com/c/{publisher}/568844/9383?veh=aff&sourceid=...&u={item page}.
 */
export function walmartProductUrl(itemId, publisherId) {
  const base = `https://www.walmart.com/ip/${encodeURIComponent(itemId)}`;
  if (!publisherId) return base;
  return `https://goto.walmart.com/c/${encodeURIComponent(publisherId)}/568844/9383?veh=aff&sourceid=imp_000011112222333344&u=${encodeURIComponent(base)}`;
}
