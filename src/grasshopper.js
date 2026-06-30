'use strict';

const config = require('./config');

// Order status IDs (from Grasshopper API reference / orders-status).
const STATUS = {
  PENDING_ARRIVAL: 1,
  PENDING_PICKUP: 2,
  CANCELLED: 6,
};
const PENDING_STATUSES = [STATUS.PENDING_ARRIVAL, STATUS.PENDING_PICKUP];

// ---------------------------------------------------------------------------
// Real client - talks to the Grasshopper Labs REST API.
// ---------------------------------------------------------------------------
class GrasshopperClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || config.gh.baseUrl).replace(/\/+$/, '');
    // Grasshopper auth uses client_id / client_secret sent as HTTP headers.
    this.clientId = opts.clientId || opts.email || config.gh.email;
    this.clientSecret = opts.clientSecret || opts.password || config.gh.password;
    // Scope order lookups to one retailer (account) so we don't page through
    // every retailer's orders. Empty = all retailers.
    this.retailerId = opts.retailerId || config.retailerId || '';
    this._token = null;
    this._refreshToken = null;
    this._tokenExpiry = 0; // epoch ms
  }

  async _authHeader() {
    const now = Date.now();
    if (!this._token) await this._login();
    else if (now >= this._tokenExpiry - 60000) await this._refresh();
    // The API expects the raw access_token in Authorization — NO "Bearer " prefix.
    return { Authorization: this._token, 'Content-Type': 'application/json' };
  }

  // POST /api/rest/auth with client_id + client_secret as HEADERS.
  // Response: { access_token, refresh_token, expiration (ISO 8601) }
  async _login() {
    const res = await fetch(`${this.baseUrl}/api/rest/auth`, {
      method: 'POST',
      headers: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Grasshopper auth failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    this._token = data.access_token || data.token;
    this._refreshToken = data.refresh_token || null;
    this._tokenExpiry = data.expiration ? Date.parse(data.expiration) : Date.now() + 3600 * 1000;
    if (!this._token) throw new Error('Grasshopper auth succeeded but no access_token in response');
  }

  // GET /api/rest/get_token with Authorization + refresh_token headers.
  // Falls back to a full re-login if refresh is unavailable or fails.
  async _refresh() {
    if (!this._refreshToken) return this._login();
    try {
      const res = await fetch(`${this.baseUrl}/api/rest/get_token`, {
        method: 'GET',
        headers: { Authorization: this._token, refresh_token: this._refreshToken },
      });
      if (!res.ok) return this._login();
      const data = await res.json();
      this._token = data.access_token || data.token || this._token;
      if (data.refresh_token) this._refreshToken = data.refresh_token;
      this._tokenExpiry = data.expiration ? Date.parse(data.expiration) : Date.now() + 3600 * 1000;
    } catch (_) {
      return this._login();
    }
  }

  // Fetch a single page of orders, optionally for a status (null = all statuses)
  // and optionally scoped to a retailer.
  async _getPage(status, page, headers) {
    const params = [];
    if (status != null) params.push(`status=${status}`);
    params.push(`page=${page}`);
    if (this.retailerId) params.push(`retailer_id=${encodeURIComponent(this.retailerId)}`);
    const url = `${this.baseUrl}/api/orders?${params.join('&')}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`List orders failed (${res.status}): ${text}`);
    }
    const body = await res.json();
    return Array.isArray(body.data) ? body.data : [];
  }

  // List orders for a single status, walking all pages.
  //
  // The API returns { status: 'ok', data: [...] } with a FIXED page size and NO
  // pagination metadata; it ignores per_page/ref/date filters (only status+page
  // work). To avoid the slow one-page-at-a-time walk over large accounts, we
  // fetch pages in PARALLEL BATCHES and stop once a page comes back short/empty.
  async _listByStatus(status) {
    const headers = await this._authHeader();
    const CONCURRENCY = 8;
    const MAX_PAGES = 10000; // safety stop

    const first = await this._getPage(status, 1, headers);
    if (first.length === 0) return [];
    const pageSize = first.length;
    let all = first;
    if (first.length < pageSize) return all;

    let next = 2;
    let done = false;
    while (!done && next <= MAX_PAGES) {
      const pages = [];
      for (let k = 0; k < CONCURRENCY; k++) pages.push(next + k);
      next += CONCURRENCY;
      const results = await Promise.all(pages.map((p) => this._getPage(status, p, headers)));
      for (const data of results) {
        all = all.concat(data);
        if (data.length < pageSize) done = true; // a short/empty page marks the end
      }
    }
    return all;
  }

  // All pending orders (status 1 + 2), normalized. Statuses run concurrently.
  async listPendingOrders() {
    const perStatus = await Promise.all(PENDING_STATUSES.map((s) => this._listByStatus(s)));
    return perStatus.flat().map(normalizeOrder);
  }

  // Given a list of order refs, return a Map(ref -> order_id) for the refs that
  // ALREADY EXIST in Grasshopper (any status), via exact ref_order_number
  // search. Used to skip re-creating a PO and to show its matched order_id.
  // Runs in parallel batches and is retailer-scoped.
  async findOrderIdsByRef(refs) {
    const headers = await this._authHeader();
    const CONCURRENCY = 10;
    const map = new Map();
    for (let i = 0; i < refs.length; i += CONCURRENCY) {
      const batch = refs.slice(i, i + CONCURRENCY);
      const found = await Promise.all(
        batch.map(async (ref) => {
          let url = `${this.baseUrl}/api/orders?ref_order_number=${encodeURIComponent(ref)}`;
          if (this.retailerId) url += `&retailer_id=${encodeURIComponent(this.retailerId)}`;
          const res = await fetch(url, { headers });
          if (!res.ok) return null;
          const body = await res.json().catch(() => ({}));
          const rows = Array.isArray(body.data) ? body.data : [];
          // The list filter is unreliable, so verify the ref matches ourselves.
          const matches = rows.filter((o) => String(o.ref_order_number || '').trim() === ref);
          // A CANCELLED order (status 6) does NOT count as existing — it must be
          // re-created. Only a live (non-cancelled) order means "already exists".
          const live = matches.find((o) => Number(o.status) !== STATUS.CANCELLED);
          return live ? { ref, order_id: live.order_id || live.id } : null;
        })
      );
      for (const r of found) if (r) map.set(r.ref, r.order_id);
    }
    return map;
  }

  // Active regions for the dropdown.
  async listRegions() {
    const headers = await this._authHeader();
    const res = await fetch(`${this.baseUrl}/api/region`, { headers });
    if (!res.ok) throw new Error(`List regions failed (${res.status})`);
    const body = await res.json();
    const arr = Array.isArray(body) ? body : body.data || [];
    return arr
      .map((r) => ({
        id: r._id,
        name: r.name,
        short_name: r.short_name,
        active: r.visible_to_customers !== false,
        address: r.address || null,
        contact_info: r.contact_info || null,
      }))
      .filter((r) => r.id && r.active)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  // Create a single order via the structured Create Order API (Final Mile Only).
  // Body is { order: {...} }.
  async createOrder(order) {
    await this._authHeader();
    const res = await fetch(`${this.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { Authorization: this._token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Create order failed (${res.status}): ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch (_) {
      return { ok: true };
    }
  }

  // Parse a delivery CSV into an array of mapped (but NOT persisted) order
  // objects via the import endpoint (multipart, field name "file"). These
  // objects are then fed one-by-one into createOrder() to actually create them.
  async importOrders(buffer) {
    await this._authHeader(); // ensure a valid token
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: 'text/csv' }), 'orders_import.csv');
    const res = await fetch(`${this.baseUrl}/api/orders/import`, {
      method: 'POST',
      headers: { Authorization: this._token }, // raw token; let fetch set multipart boundary
      body: fd,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Import (parse) failed (${res.status}): ${text.slice(0, 300)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return [];
    }
    return Array.isArray(data) ? data : data.data || [];
  }

  // Create an (inbound) manifest. Body: { type, route_id, scheduled_date,
  // arrival_date, direction }. Returns the manifest (with _id).
  async createManifest(payload) {
    await this._authHeader();
    const res = await fetch(`${this.baseUrl}/api/manifests`, {
      method: 'POST',
      headers: { Authorization: this._token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Create manifest failed (${res.status}): ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return data.data || data;
  }

  // Add orders + line items to a manifest in one batch.
  async addManifestEntries(manifestId, body) {
    await this._authHeader();
    const res = await fetch(`${this.baseUrl}/api/manifests/${encodeURIComponent(manifestId)}/entries`, {
      method: 'POST',
      headers: { Authorization: this._token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Add manifest entries failed (${res.status}): ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch (_) {
      return { ok: true };
    }
  }

  async cancelOrder(orderId, reason) {
    const headers = await this._authHeader();
    const res = await fetch(`${this.baseUrl}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: reason || config.cancelReason }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let code = '';
      try {
        code = (JSON.parse(text).error || {}).code || '';
      } catch (_) {}
      throw new Error(`Cancel ${orderId} failed (${res.status})${code ? ' ' + code : ''}: ${text}`);
    }
    return res.json().catch(() => ({ order_id: orderId, status: STATUS.CANCELLED }));
  }
}

// Normalize an order object to the fields the engine relies on.
function normalizeOrder(o) {
  const lineItems = Array.isArray(o.line_items) ? o.line_items : [];
  return {
    order_id: String(o.order_id),
    ref_order_number: (o.ref_order_number || '').trim(),
    status: o.status,
    created_at: o.created_at || null,
    customer: o.customer || null,
    line_items: lineItems.map((li) => ({
      // Grasshopper does not document the per-item id field name, so accept the
      // common variants. Used to report which item matches each Master ASN.
      item_id: String(li.item_id ?? li.id ?? li.line_item_id ?? li.itemId ?? ''),
      sku: (li.sku || '').toString().trim(),
      name: li.name,
      quantity: li.quantity,
    })),
    skus: lineItems.map((li) => (li.sku || '').toString().trim()).filter(Boolean),
    raw: o,
  };
}

// ---------------------------------------------------------------------------
// Mock client - fabricates a Grasshopper-like order set from the uploaded
// files so the full flow can be tested locally without touching production.
//
// It builds:
//   * one pending order per unique Sales# in the delivery file
//     (status alternates 1/2, created_at from Create Date, line_item.sku set
//      to one of the trailers' Master ASNs round-robin so ASN matching works)
//   * a few "ghost" pending orders whose ref_order_number is NOT in the
//     delivery file, so the cancel list is non-empty.
// ---------------------------------------------------------------------------
class MockGrasshopperClient {
  constructor(seed) {
    // seed: { delivery: [records], asn: [records] }
    const all = buildMockOrders(seed || { delivery: [], asn: [] });
    // Hold out ~1/8 of the real (non-ghost) orders as "not yet created" so the
    // create step has something to demo. mockCreatePending() activates them.
    this._orders = [];
    this._uncreated = [];
    let n = 0;
    for (const o of all) {
      const ref = String(o.ref_order_number);
      if (!ref.startsWith('GHOST') && !ref.startsWith('EXIST') && n++ % 8 === 3) this._uncreated.push(o);
      else this._orders.push(o);
    }
    this._cancelled = new Set();
  }

  async listPendingOrders() {
    return this._orders.filter((o) => !this._cancelled.has(o.order_id)).map((o) => ({ ...o }));
  }

  mockCreatePending() {
    const n = this._uncreated.length;
    this._orders.push(...this._uncreated);
    this._uncreated = [];
    return n;
  }

  // Activate one held-out order by ref (used by the per-PO create flow).
  mockCreateRef(ref) {
    const idx = this._uncreated.findIndex((o) => o.ref_order_number === ref);
    if (idx < 0) return null;
    const o = this._uncreated.splice(idx, 1)[0];
    this._orders.push(o);
    return o;
  }

  async listRegions() {
    const addr = (a1, city, st, zip) => ({ address1: a1, address2: '', city, state: st, zip });
    return [
      { id: 'mock-co', name: 'Colorado Furniture Crossdock', short_name: 'CO', active: true, address: addr('8220 Allison Ave', 'Denver', 'CO', '80210') },
      { id: 'mock-tx', name: 'Texas Hub', short_name: 'TX', active: true, address: addr('100 Main St', 'Dallas', 'TX', '75201') },
      { id: 'mock-ca', name: 'California Hub', short_name: 'CA', active: true, address: addr('5 Pier Ave', 'Los Angeles', 'CA', '90036') },
    ];
  }

  async findOrderIdsByRef() {
    return new Map(); // mock: treat nothing as pre-existing
  }

  async createOrder() {
    return { ok: true, mock: true };
  }

  async createManifest() {
    return { _id: 'MOCK-MANIFEST-' + Date.now(), mock: true };
  }

  async addManifestEntries() {
    return { ok: true, mock: true };
  }

  async importOrders() {
    // Mock orders are built from the uploaded files, so nothing to create.
    return { ok: true, mock: true };
  }

  async cancelOrder(orderId) {
    if (!this._orders.find((o) => o.order_id === orderId)) {
      throw new Error(`Cancel ${orderId} failed: order not found (mock)`);
    }
    this._cancelled.add(orderId);
    return { order_id: orderId, status: STATUS.CANCELLED, cancelled_at: new Date().toISOString(), mock: true };
  }
}

function buildMockOrders(seed) {
  const { parseCreateDate, deliveryOrderRef, normSku, asnSku } = require('./parser');
  const refToCreate = new Map();
  const refToRow = new Map();
  for (const rec of seed.delivery || []) {
    const ref = deliveryOrderRef(rec);
    if (!ref) continue;
    if (!refToRow.has(ref)) {
      refToRow.set(ref, rec);
      refToCreate.set(ref, parseCreateDate(rec['Create Date']) || new Date().toISOString());
    }
  }

  const orders = [];
  let i = 0;
  let idSeq = 22200000000;
  for (const [ref, created] of refToCreate.entries()) {
    const rec = refToRow.get(ref);
    // Use the real product SKU from the delivery row, so orders whose product
    // is on an inbound trailer match by SKU (commas stripped) in the demo.
    const productSku = normSku(rec['Sku']);
    orders.push({
      order_id: String(++idSeq),
      ref_order_number: ref,
      status: i % 2 === 0 ? STATUS.PENDING_PICKUP : STATUS.PENDING_ARRIVAL,
      created_at: created,
      customer: {
        first_name: rec['Ship To Cust Name'] || '',
        last_name: '',
        address: { city: (rec['Ship To City'] || '').trim(), state: rec['Ship To State'] || '' },
      },
      line_items: [
        {
          item_id: `${idSeq}-1`,
          sku: productSku,
          name: rec['Sku Description'] || '',
          quantity: rec['Pieces Quantity'] || 1,
        },
        // Every 3rd order gets a second item with a non-inbound SKU, so it is
        // only PARTIALLY fulfillable — exercises the fully-fulfilled flag.
        ...(i % 3 === 0
          ? [{ item_id: `${idSeq}-2`, sku: `EXTRA-${productSku}`, name: 'Backordered item', quantity: 1 }]
          : []),
      ],
      skus: i % 3 === 0 ? [productSku, `EXTRA-${productSku}`] : [productSku],
    });
    i++;
  }

  // Ghost orders -> should appear in the cancel list (not in the delivery file).
  for (let g = 1; g <= 5; g++) {
    orders.push({
      order_id: String(++idSeq),
      ref_order_number: `GHOST-${g}-${Math.floor(Math.random() * 1e6)}`,
      status: g % 2 === 0 ? STATUS.PENDING_PICKUP : STATUS.PENDING_ARRIVAL,
      created_at: new Date(Date.now() - g * 86400000).toISOString(),
      customer: { first_name: 'Ghost', last_name: `Order ${g}`, address: { city: 'NOWHERE', state: 'XX' } },
      line_items: [{ item_id: `${idSeq}-1`, sku: `GHOST-SKU-${g}`, name: 'Stale order not on file', quantity: 1 }],
      skus: [`GHOST-SKU-${g}`],
    });
  }

  // When NO delivery file is uploaded (ASN-only matching demo), seed a few
  // standing pending orders whose SKUs come from the ASN, so the manifest is
  // non-empty in mock mode. In real mode these come from Grasshopper.
  if ((seed.delivery || []).length === 0) {
    const asnSkus = [...new Set((seed.asn || []).map(asnSku).filter(Boolean))];
    asnSkus.slice(0, 15).forEach((sku, k) => {
      orders.push({
        order_id: String(++idSeq),
        ref_order_number: `EXIST-${k + 1}`,
        status: k % 2 === 0 ? STATUS.PENDING_PICKUP : STATUS.PENDING_ARRIVAL,
        created_at: new Date(Date.now() - k * 3600000).toISOString(),
        customer: { first_name: 'Existing', last_name: `Order ${k + 1}`, address: { city: 'Denver', state: 'CO' } },
        line_items: [{ item_id: `${idSeq}-1`, sku, name: 'Standing order', quantity: 1 }],
        skus: [sku],
      });
    });
  }

  return orders;
}

function makeClient(seed) {
  if (config.mockMode) return new MockGrasshopperClient(seed);
  return new GrasshopperClient();
}

module.exports = {
  GrasshopperClient,
  MockGrasshopperClient,
  makeClient,
  normalizeOrder,
  STATUS,
  PENDING_STATUSES,
};
