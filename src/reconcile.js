'use strict';

const { deliveryOrderRef, asnMasterAsn, asnTrailerId, asnSku, normSku } = require('./parser');
const { STATUS } = require('./grasshopper');

const STATUS_LABEL = {
  1: 'Pending Arrival',
  2: 'Pending Pickup',
  6: 'Cancelled',
};

function sortByCreatedAsc(a, b) {
  const ta = a.created_at ? Date.parse(a.created_at) : Infinity;
  const tb = b.created_at ? Date.parse(b.created_at) : Infinity;
  if (ta !== tb) return ta - tb;
  return String(a.order_id).localeCompare(String(b.order_id));
}

/**
 * Core reconciliation. Pure function: no API calls, no side effects.
 *
 * @param pendingOrders  normalized GH orders in status 1/2
 * @param delivery       delivery file records (flattened)
 * @param asn            ASN file records (flattened, merged across trailers)
 * @returns { toCancel, manifest, masterAsns, deliveryRefs, stats }
 */
function reconcile(pendingOrders, delivery, asn) {
  const hasDelivery = Array.isArray(delivery) && delivery.length > 0;

  // 1. Set of order refs present on the delivery file (Sales# -> ref_order_number).
  const deliveryRefs = new Set();
  for (const rec of delivery) {
    const ref = deliveryOrderRef(rec);
    if (ref) deliveryRefs.add(ref);
  }

  // 2. Cancel list = pending GH orders whose ref is NOT on the delivery file.
  //    Only meaningful when a delivery file was uploaded — otherwise we cannot
  //    know which orders are "not on the file", so nothing is cancelled.
  const toCancel = hasDelivery
    ? pendingOrders.filter((o) => !deliveryRefs.has((o.ref_order_number || '').trim())).sort(sortByCreatedAsc)
    : [];
  const toCancelIds = new Set(toCancel.map((o) => o.order_id));

  // 3. From the merged ASN files, build the set of inbound product SKUs and a
  //    map sku -> set of Master ASNs (trailers) carrying that SKU. Matching is
  //    product-SKU to product-SKU (commas stripped); Master ASN identifies the
  //    trailer the item arrives on.
  const asnSkus = new Set();
  const masterAsns = new Set();
  const skuToTrailers = new Map(); // sku -> Set(master ASN)
  for (const rec of asn) {
    const sku = asnSku(rec);
    const m = asnMasterAsn(rec);
    if (m) masterAsns.add(m);
    if (!sku) continue;
    asnSkus.add(sku);
    if (!skuToTrailers.has(sku)) skuToTrailers.set(sku, new Set());
    if (m) skuToTrailers.get(sku).add(m);
    else if (asnTrailerId(rec)) skuToTrailers.get(sku).add(asnTrailerId(rec));
  }

  // 3b. PICKUP exclusion. Delivery rows whose "Item Note" contains PICKUP are
  //     pickups, not deliveries — we don't try to fulfill them. We key them by
  //     order ref + SKU (the link to a Grasshopper line item). A (ref, sku)
  //     that ONLY ever appears as a pickup is excluded from matching.
  const pickupKeys = new Set();
  const deliverableKeys = new Set();
  const keyOf = (ref, sku) => `${ref}||${sku}`;
  for (const rec of delivery) {
    const ref = deliveryOrderRef(rec);
    const sku = normSku(rec['Sku']);
    if (!ref || !sku) continue;
    if (/pickup/i.test(String(rec['Item Note'] || ''))) pickupKeys.add(keyOf(ref, sku));
    else deliverableKeys.add(keyOf(ref, sku));
  }
  const isPickupOnly = (order, li) => {
    const k = keyOf((order.ref_order_number || '').trim(), normSku(li.sku));
    return pickupKeys.has(k) && !deliverableKeys.has(k);
  };

  // 4. Manifest = pending orders that (a) survive (are on the delivery file,
  //    i.e. not in the cancel list) AND (b) have a deliverable line item whose
  //    product SKU is arriving on an inbound trailer. Sorted oldest-first (FIFO).
  const manifest = pendingOrders
    .filter((o) => !toCancelIds.has(o.order_id))
    .map((o) => {
      // Line items we actually try to fulfill (exclude pickup-only entries).
      const fulfillable = (o.line_items || []).filter((li) => !isPickupOnly(o, li));
      const matchedItems = fulfillable
        .filter((li) => asnSkus.has(normSku(li.sku)))
        .map((li) => ({
          item_id: li.item_id || '',
          sku: normSku(li.sku),
          master_asns: Array.from(skuToTrailers.get(normSku(li.sku)) || []),
        }));
      const totalItems = fulfillable.length;
      const fullyFulfilled = totalItems > 0 && matchedItems.length === totalItems;
      return {
        ...o,
        matched_items: matchedItems,
        total_items: totalItems,
        matched_count: matchedItems.length,
        fully_fulfilled: fullyFulfilled,
      };
    })
    .filter((o) => o.matched_items.length > 0)
    .sort(sortByCreatedAsc);

  // 5. Flatten to LINE-ITEM rows in FIFO order. Each matched line item becomes
  //    a row carrying the order # and line item #, ready for the inbound
  //    manifest. Orders are already oldest-first; we keep that order.
  const manifestLines = [];
  let seq = 0;
  for (const o of manifest) {
    for (const mi of o.matched_items) {
      manifestLines.push({
        fifo_seq: ++seq,
        order_id: o.order_id,
        ref_order_number: o.ref_order_number,
        line_item_id: mi.item_id,
        sku: mi.sku,
        trailer: (mi.master_asns || []).join(', '),
        fully_fulfilled: o.fully_fulfilled ? 'Yes' : 'No',
        items_matched: `${o.matched_count}/${o.total_items}`,
        status_label: STATUS_LABEL[o.status] || String(o.status),
        created_at: o.created_at || '',
      });
    }
  }

  // 6. Plain-language decision log so a person can audit every choice. Each
  //    entry has a `kind` (for filtering) and a readable `text` that contains
  //    the order #, order id and SKU, so a free-text search finds it.
  const log = [];
  const add = (kind, text) => log.push({ kind, text });

  add('info', `Loaded ${pendingOrders.length} pending order(s) from Grasshopper (Pending Pickup or Pending Arrival).`);
  add('info', `Delivery file lists ${deliveryRefs.size} order(s) (by Sales#). Orders not on this list will be cancelled.`);
  add('info', `ASN files list ${asnSkus.size} inbound SKU(s) across ${masterAsns.size} trailer(s). Orders are matched to these SKUs, oldest first (FIFO).`);

  for (const sku of asnSkus) {
    const trailers = Array.from(skuToTrailers.get(sku) || []).join(', ') || 'unknown trailer';
    add('asn', `Inbound SKU ${sku} is arriving on trailer ${trailers}.`);
  }

  for (const o of toCancel) {
    add('cancel', `CANCEL — order ${o.ref_order_number} (id ${o.order_id}) is pending in Grasshopper but is NOT on today's delivery file, so it should be cancelled.`);
  }

  for (const ln of manifestLines) {
    add(
      'match',
      `MATCH #${ln.fifo_seq} — order ${ln.ref_order_number} (id ${ln.order_id}): line item ${ln.line_item_id} with SKU ${ln.sku} is arriving on trailer ${ln.trailer}, so it is added to the inbound manifest. Order fully fulfilled: ${ln.fully_fulfilled} (${ln.items_matched} items matched).`
    );
  }

  const matchedIds = new Set(manifest.map((o) => o.order_id));
  for (const o of pendingOrders) {
    if (toCancelIds.has(o.order_id) || matchedIds.has(o.order_id)) continue;
    add(
      'skip',
      `WAIT — order ${o.ref_order_number} (id ${o.order_id}) is on the delivery file (so it is kept, not cancelled), but none of its SKUs (${(o.skus || []).join(', ') || 'n/a'}) are on the inbound trailers yet, so it is not on this manifest.`
    );
  }

  add(
    'info',
    `Result: ${manifestLines.length} line item(s) across ${manifest.length} order(s) added to the inbound manifest (FIFO order); ${toCancel.length} order(s) flagged to cancel.`
  );

  return {
    toCancel,
    manifest,
    manifestLines,
    log,
    asnSkus: Array.from(asnSkus),
    masterAsns: Array.from(masterAsns),
    deliveryRefs: Array.from(deliveryRefs),
    stats: {
      pendingTotal: pendingOrders.length,
      deliveryRefCount: deliveryRefs.size,
      toCancelCount: toCancel.length,
      manifestCount: manifest.length,
      manifestLineCount: manifestLines.length,
      asnSkuCount: asnSkus.size,
      masterAsnCount: masterAsns.size,
    },
  };
}

// Plain rows for JSON/preview and Excel output.
function orderToRow(o) {
  const cust = o.customer || {};
  const addr = cust.address || {};
  return {
    order_id: o.order_id,
    ref_order_number: o.ref_order_number,
    status: o.status,
    status_label: STATUS_LABEL[o.status] || String(o.status),
    created_at: o.created_at || '',
    // Matched product SKUs on this order that are arriving inbound.
    matched_skus: [...new Set((o.matched_items || []).map((m) => m.sku))].join(', '),
    // "item_id -> SKU" for every matched item on the order.
    matched_items: (o.matched_items || []).map((m) => `${m.item_id || '?'} -> ${m.sku}`).join('; '),
    // Inbound trailer(s) (Master ASN) carrying the matched SKUs.
    trailers: [...new Set((o.matched_items || []).flatMap((m) => m.master_asns || []))].join(', '),
    customer: [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim(),
    city: addr.city || '',
    state: addr.state || '',
    skus: (o.skus || []).join(', '),
  };
}

module.exports = { reconcile, orderToRow, STATUS_LABEL };
