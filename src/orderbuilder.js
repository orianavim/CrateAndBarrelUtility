'use strict';

const { deliveryOrderRef } = require('./parser');

function s(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}
function num(v) {
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

// Per-line-item serial_number: "OP: <Open Instruction>; ASSMBL:<Assembly
// Instruction>", left-padded to 25 chars with an invisible zero-width space so
// short values still reach a 25-char minimum width without showing padding.
const SERIAL_PAD = '\u200B'; // zero-width space (invisible)
function buildSerialNumber(row) {
  const r = row || {};
  const content = `OP: ${s(r['Open Instruction'])}; ASSMBL:${s(r['Assembly Instruction'])}`;
  return content.padStart(25, SERIAL_PAD);
}

// Normalize a zip to the 5-digit standard (same as regular orders): keep digits
// only, take the first 5 (drops ZIP+4), left-pad short zips to restore a leading
// zero. "80209-1234" -> "80209", "8209" -> "08209".
function zip5(v) {
  const digits = String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length >= 5 ? digits.slice(0, 5) : digits.padStart(5, '0');
}

// Split "Ship To Cust Name" like "HIMELSTEIN*MICHAEL".
// Matches the prior import: first_name = text before '*', last_name = text after.
function splitName(name) {
  const parts = s(name).split('*');
  return { first_name: s(parts[0]), last_name: s(parts[1] || '') };
}

// Build Create-Order payloads (Final Mile Only) for the given Sales# refs,
// grouping all delivery rows of a PO into one order with multiple line items.
//
// opts: { retailerIdentifier, serviceLevel='wg', vendor='Crate and Barrel' }
function buildOrders(deliveryRecords, refSet, opts = {}) {
  const serviceLevel = opts.serviceLevel || 'wg';
  const vendor = opts.vendor || 'Crate and Barrel';
  const retailerIdentifier = opts.retailerIdentifier || '';

  const rowsByRef = new Map();
  for (const rec of deliveryRecords) {
    const ref = deliveryOrderRef(rec);
    if (!ref || !refSet.has(ref)) continue;
    if (!rowsByRef.has(ref)) rowsByRef.set(ref, []);
    rowsByRef.get(ref).push(rec);
  }

  const orders = [];
  for (const [ref, rows] of rowsByRef.entries()) {
    const first = rows[0] || {};
    const name = splitName(first['Ship To Cust Name']);
    const phone2 = s(first['Phone2 Num']);
    const order = {
      retailer: { identifier: retailerIdentifier },
      service_level: serviceLevel,
      ref_order_number: ref,
      customer: {
        first_name: name.first_name,
        last_name: name.last_name,
        company: s(first['Ship To Buss Name']),
        address: {
          address1: s(first['Ship To Address 1']),
          address2: s(first['Ship To Address 2']),
          city: s(first['Ship To City']),
          state: s(first['Ship To State']),
          zip: s(first['Ship To Zip']),
        },
        phone1: { number: s(first['Phone1 Num']) },
        email: s(first['Email Address']),
      },
      total_insurance_coverage: 0,
      line_items: rows.map((rec) => ({
        quantity: num(rec['Pieces Quantity']) || 1,
        sku: s(rec['Sku']),
        name: s(rec['Sku Description']),
        retail_value: num(rec['Value']),
        weight: 0,
        cube: 0,
        category: '',
        vendor,
        // FOB the vendor: items ship to the crossdock, no Grasshopper pickup.
        // Required by the Create Order API (otherwise it demands a pickup zip).
        freight_info: { is_fob: true },
      })),
      note: s(first['Order Note 1']),
    };
    if (phone2) order.customer.phone2 = { number: phone2 };
    orders.push({ ref, order });
  }
  return orders;
}

// Build a SERVICE TICKET (type 4) from the delivery rows of one PO.
// Everything collapses into a SINGLE line item: name = all Sku Descriptions
// joined with ", "; sku = all Skus joined with ", "; category type 1.
// opts: { retailerIdentifier, serviceLevel='wg', vendor='Crate and Barrel' }
function buildServiceTicket(rows, opts = {}) {
  const first = rows[0] || {};
  const name = splitName(first['Ship To Cust Name']);
  const phone2 = s(first['Phone2 Num']);
  const descriptions = rows.map((r) => s(r['Sku Description'])).filter(Boolean).join(', ');
  const skus = rows.map((r) => s(r['Sku'])).filter(Boolean).join(', ');
  const order = {
    retailer: { identifier: opts.retailerIdentifier || '' },
    type: 4,
    ref_order_number: deliveryOrderRef(first),
    service_level: opts.serviceLevel || 'wg',
    total_insurance_coverage: 0,
    customer: {
      first_name: name.first_name,
      last_name: name.last_name,
      company: s(first['Ship To Buss Name']),
      address: {
        address1: s(first['Ship To Address 1']),
        address2: s(first['Ship To Address 2']),
        city: s(first['Ship To City']),
        state: s(first['Ship To State']),
        zip: zip5(first['Ship To Zip']),
      },
      phone1: { number: s(first['Phone1 Num']) },
      email: s(first['Email Address']),
    },
    line_items: [
      {
        name: descriptions,
        sku: skus,
        category: 1,
        quantity: 1,
        vendor: opts.vendor || 'Crate and Barrel',
        freight_info: { is_fob: true },
        serial_number: buildSerialNumber(first),
      },
    ],
    note: s(first['Order Note 1']),
  };
  if (phone2) order.customer.phone2 = { number: phone2 };
  return order;
}

module.exports = { buildOrders, buildServiceTicket, buildSerialNumber, splitName };
