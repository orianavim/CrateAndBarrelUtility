'use strict';

// End-to-end smoke test in MOCK mode against SELF-GENERATED fixtures, so it is
// deterministic and independent of whatever sample files are in the folder.
process.env.MOCK_MODE = 'true';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { parseBatch } = require('../src/parser');
const { makeClient } = require('../src/grasshopper');
const { reconcile, orderToRow } = require('../src/reconcile');
const { buildWorkbook } = require('../src/excel');
const XLSX = require('xlsx');

function buildXls(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
}

const SKUS = ['175590', '175591', '175592', '175593', '175594', '175595', '175596', '175597', '175598'];
const D_HEADER = ['Status','Sales#','Sku','Sku Description','Pieces Quantity','Value','Item Note','Service Level','Ship To Cust Name','Ship To City','Ship To State','Create Date','Delivery Date'];
const dOrders = SKUS.map((sku, idx) => {
  const i = idx + 1;
  const note = i === 9 ? 'PICKUP' : ''; // one pickup line to exercise exclusion
  return [100, `CB-${String(i).padStart(3, '0')}`, sku, `ITEM ${i}`, 1, 100 + i, note, 'LOC', `LAST${i}*FIRST${i}`, 'Denver', 'CO', `2026-06-09-03.57.${String(40 + i).padStart(2, '0')}.000000`, '2026-06-09'];
});
const deliveryAoa = [['MXD Delivery CSV'], ['MXD001  MXD Delivery CSV'], [], [], D_HEADER, ...dOrders];

const A_HEADER = ['Trailer Id','Master ASN','ASN Number','Ship To Company','Ship To Location','Receiving Company','Receiving Location','Ship Date','Sku','Sku Description','Sku Quantity'];
const aRows = SKUS.slice(0, 6).map((sku, idx) => ['TRL-1', '04039000000000001-791', '04039000100000001-100', 100, 390, 100, 791, '20260609', sku, `ITEM ${idx + 1}`, 1]);
const asnAoa = [['MXD CSV for ASN'], ['MXD001  MXD CSV for ASN'], [], [], A_HEADER, ...aRows];

const files = [
  { originalname: 'TEST_Delivery.xls', buffer: buildXls(deliveryAoa) },
  { originalname: 'TEST_ASN.xls', buffer: buildXls(asnAoa) },
];

(async () => {
  // 1. Parse + type detection
  const parsed = parseBatch(files);
  console.log('--- file detection ---');
  for (const s of parsed.summary) console.log(`  ${s.type.padEnd(9)} ${s.fileName} (${s.count} rows)`);
  if (parsed.warnings.length) console.log('  warnings:', parsed.warnings);

  const deliveryCount = parsed.summary.filter((s) => s.type === 'delivery').length;
  const asnCount = parsed.summary.filter((s) => s.type === 'asn').length;
  assert(deliveryCount >= 1, 'should detect at least one delivery file');
  assert(asnCount >= 1, 'should detect at least one ASN file');
  assert(parsed.delivery.length > 0, 'delivery records parsed');
  assert(parsed.asn.length > 0, 'asn records parsed');

  // 2. Mock GH + reconcile
  const client = makeClient({ delivery: parsed.delivery, asn: parsed.asn });
  const pending = await client.listPendingOrders();
  const result = reconcile(pending, parsed.delivery, parsed.asn);

  console.log('\n--- reconciliation ---');
  console.log('  pending orders (mock):', result.stats.pendingTotal);
  console.log('  delivery refs        :', result.stats.deliveryRefCount);
  console.log('  inbound SKUs (ASN)   :', result.stats.asnSkuCount);
  console.log('  inbound trailers     :', result.stats.masterAsnCount);
  console.log('  to cancel            :', result.stats.toCancelCount);
  console.log('  on manifest          :', result.stats.manifestCount);

  assert(result.stats.asnSkuCount >= 1, 'should find inbound product SKUs');
  assert(result.stats.toCancelCount >= 1, 'mock injects ghost orders -> cancel list non-empty');
  assert(result.stats.manifestCount >= 1, 'manifest should contain matched orders');

  // manifest must be FIFO (created_at ascending)
  const times = result.manifest.map((o) => Date.parse(o.created_at) || 0);
  for (let i = 1; i < times.length; i++) assert(times[i] >= times[i - 1], 'manifest not FIFO-sorted');

  // cancel list refs must NOT be on delivery file
  const deliverySet = new Set(result.deliveryRefs);
  for (const o of result.toCancel) assert(!deliverySet.has(o.ref_order_number), 'cancel order should not be on file');

  // manifest orders MUST be on the delivery file and carry an inbound SKU
  const asnSkuSet = new Set(result.asnSkus);
  for (const o of result.manifest) {
    assert(deliverySet.has(o.ref_order_number), 'manifest order must be on delivery file');
    assert(o.skus.some((s) => asnSkuSet.has(s)), 'manifest order must carry an inbound SKU');
  }

  // every manifest order should report at least one "item_id -> SKU" match
  for (const o of result.manifest) {
    assert(o.matched_items && o.matched_items.length >= 1, 'manifest order must list matched item-ids');
    for (const mi of o.matched_items) assert(asnSkuSet.has(mi.sku), 'matched item sku must be an inbound SKU');
  }

  // line-item manifest: one row per matched item, FIFO seq, sku inbound, order is on file
  assert(result.manifestLines.length >= result.manifest.length, 'line items >= orders');
  assert(result.stats.manifestLineCount === result.manifestLines.length, 'line count stat matches');
  let lastSeq = 0, lastT = 0;
  for (const ln of result.manifestLines) {
    assert(ln.fifo_seq === lastSeq + 1, 'FIFO seq must be contiguous'); lastSeq = ln.fifo_seq;
    assert(ln.order_id && ln.line_item_id && ln.sku, 'line row needs order#, line item#, sku');
    assert(asnSkuSet.has(ln.sku), 'line sku must be inbound');
    assert(deliverySet.has(ln.ref_order_number), 'line order must be on file (not cancelled)');
    const t = Date.parse(ln.created_at) || 0; assert(t >= lastT, 'line items must stay FIFO'); lastT = t;
  }
  // fully-fulfilled flag present and both values occur (mock injects partials)
  const ffVals = new Set(result.manifestLines.map((l) => l.fully_fulfilled));
  for (const l of result.manifestLines) {
    assert(l.fully_fulfilled === 'Yes' || l.fully_fulfilled === 'No', 'fully_fulfilled must be Yes/No');
    assert(/^\d+\/\d+$/.test(l.items_matched), 'items_matched must be like 1/2');
  }
  assert(ffVals.has('Yes') && ffVals.has('No'), 'mock should produce both fully and partially fulfilled orders');
  const partials = result.manifest.filter((o) => !o.fully_fulfilled).length;
  console.log('  manifest line items  :', result.manifestLines.length);
  console.log('  partial orders       :', partials, '| fully:', result.manifest.length - partials);
  console.log('  sample line row      :', result.manifestLines[0]);

  // decision log: present, has expected kinds, and is searchable by order id + sku
  assert(Array.isArray(result.log) && result.log.length > 0, 'log should be produced');
  const kinds = new Set(result.log.map((e) => e.kind));
  for (const k of ['info', 'asn', 'cancel', 'match']) assert(kinds.has(k), `log should contain ${k} entries`);
  const sampleLine = result.manifestLines[0];
  assert(result.log.some((e) => e.text.includes(sampleLine.order_id)), 'log searchable by order id');
  assert(result.log.some((e) => e.text.includes(sampleLine.sku)), 'log searchable by sku');
  const cancelOrder = result.toCancel[0];
  assert(result.log.some((e) => e.kind === 'cancel' && e.text.includes(cancelOrder.ref_order_number)), 'cancel decision logged');
  console.log('  log lines            :', result.log.length, '| kinds:', [...kinds].join(','));
  console.log('  sample log (match)   :', (result.log.find((e) => e.kind === 'match') || {}).text);

  // 3. Confirm-cancel (mock) then verify they disappear from pending
  let cancelled = 0;
  for (const o of result.toCancel) { await client.cancelOrder(o.order_id); cancelled++; }
  const after = await client.listPendingOrders();
  assert(after.length === pending.length - cancelled, 'cancelled orders should leave pending set');
  console.log('\n--- cancellation (mock) ---');
  console.log('  cancelled            :', cancelled);
  console.log('  pending after        :', after.length);

  // 4. Build workbook and verify sheets
  const buf = buildWorkbook(result, { mockMode: true, fileSummary: parsed.summary, cancelsApplied: cancelled });
  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepStrictEqual(wb.SheetNames, ['Summary', 'Inbound Manifest', 'To Cancel']);
  const outPath = path.join(__dirname, 'sample-output.xlsx');
  fs.writeFileSync(outPath, buf);
  console.log('\n--- output ---');
  console.log('  workbook sheets      :', wb.SheetNames.join(', '));
  console.log('  written              :', outPath);

  console.log('\nALL TESTS PASSED');
})().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
