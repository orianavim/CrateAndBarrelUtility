'use strict';

const XLSX = require('xlsx');
const { orderToRow } = require('./reconcile');

// Build an .xlsx workbook (Buffer) with Summary, Inbound Manifest, To Cancel.
function buildWorkbook(result, meta = {}) {
  const wb = XLSX.utils.book_new();

  // ---- Summary sheet ----
  const summaryRows = [
    ['Crate & Barrel - Inbound Manifest / Reconciliation'],
    ['Generated', new Date().toISOString()],
    ['Mode', meta.mockMode ? 'MOCK (no live API calls)' : 'LIVE'],
    [],
    ['Pending orders in Grasshopper (status 1/2)', result.stats.pendingTotal],
    ['Order refs on delivery file', result.stats.deliveryRefCount],
    ['Inbound product SKUs (ASN files)', result.stats.asnSkuCount],
    ['Inbound trailers (Master ASNs)', result.stats.masterAsnCount],
    ['Orders to cancel (not on file)', result.stats.toCancelCount],
    ['Orders on inbound manifest', result.stats.manifestCount],
    ['Line items on inbound manifest', result.stats.manifestLineCount],
  ];
  if (meta.cancelsApplied !== undefined) {
    summaryRows.push([], ['Cancellations applied', meta.cancelsApplied]);
    const failCount = meta.cancelStatusById
      ? Object.values(meta.cancelStatusById).filter((v) => String(v).startsWith('error')).length
      : 0;
    if (failCount) summaryRows.push(['Cancellation failures', failCount]);
  }
  if (meta.fileSummary && meta.fileSummary.length) {
    summaryRows.push([], ['Uploaded files', 'Type', 'Rows']);
    for (const f of meta.fileSummary) summaryRows.push([f.fileName, f.type, f.count]);
  }
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 42 }, { wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // ---- Inbound Manifest sheet (one row per matched LINE ITEM, FIFO order) ----
  const lineRows = (result.manifestLines || []).map((r) => ({
    'FIFO #': r.fifo_seq,
    'Order #': r.ref_order_number,
    'Order ID': r.order_id,
    'Line Item #': r.line_item_id,
    SKU: r.sku,
    Trailer: r.trailer,
    'Fully Fulfilled': r.fully_fulfilled,
    'Items Matched': r.items_matched,
    Status: r.status_label,
    'Order Created': r.created_at,
  }));
  const wsManifest = XLSX.utils.json_to_sheet(
    lineRows.length ? lineRows : [{ 'FIFO #': '', 'Order #': '', note: 'No matching line items' }]
  );
  wsManifest['!cols'] = autoCols(lineRows);
  XLSX.utils.book_append_sheet(wb, wsManifest, 'Inbound Manifest');

  // ---- To Cancel sheet (clean columns) ----
  const cancelRows = result.toCancel.map((o) => {
    const r = orderToRow(o);
    const row = {
      'Order ID': r.order_id,
      'Ref Order #': r.ref_order_number,
      Status: r.status_label,
      Created: r.created_at,
      'Customer Name': r.customer,
      City: r.city,
      State: r.state,
    };
    if (meta.cancelStatusById && meta.cancelStatusById[o.order_id]) {
      row['Cancel Result'] = meta.cancelStatusById[o.order_id];
    }
    return row;
  });
  const wsCancel = XLSX.utils.json_to_sheet(
    cancelRows.length ? cancelRows : [{ 'Order #': '', note: 'Nothing to cancel' }]
  );
  wsCancel['!cols'] = autoCols(cancelRows);
  XLSX.utils.book_append_sheet(wb, wsCancel, 'To Cancel');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function autoCols(rows) {
  if (!rows.length) return [{ wch: 16 }];
  const keys = Object.keys(rows[0]);
  return keys.map((k) => {
    const maxLen = Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length));
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
}

module.exports = { buildWorkbook };
