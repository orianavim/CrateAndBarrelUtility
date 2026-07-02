'use strict';

const XLSX = require('xlsx');

function norm(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

// Build a Grasshopper import file (CSV Buffer) from the uploaded delivery
// file(s), keeping only rows whose Sales# is in `missingRefSet`.
//
// Per the import spec the Excel orders file is converted to CSV and the first 4
// rows (the "MXD Delivery CSV" marker / blank rows) are removed, so the file
// starts at the real column-header row. Formatted cell values are used (e.g.
// the SKU stays "175,590" with its comma, matching the manual Excel→CSV export
// the importer expects).
//
// @param deliveryBuffers  array of raw delivery file Buffers
// @param missingRefSet    Set of trimmed Sales# values to include
// @returns Buffer | null  (null if there is nothing to import)
function buildImportBuffer(deliveryBuffers, missingRefSet) {
  let header = null;
  const dataRows = [];

  for (const buf of deliveryBuffers) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // raw:false -> use formatted (display) text, like a real Excel→CSV export.
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

    // Find the real column-header row (the one with Status + Sales#). Everything
    // above it (the first marker rows) is dropped.
    const hIdx = rows.findIndex((r) => {
      const cells = (r || []).map(norm);
      return cells.includes('Sales#') && cells.includes('Status');
    });
    if (hIdx < 0) continue;
    if (!header) header = rows[hIdx];

    const salesIdx = rows[hIdx].findIndex((c) => norm(c) === 'Sales#');
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.every((c) => norm(c) === '')) continue;
      if (missingRefSet.has(norm(r[salesIdx]))) dataRows.push(r);
    }
  }

  if (!header || dataRows.length === 0) return null;

  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  const csv = XLSX.utils.sheet_to_csv(ws);
  return Buffer.from(csv, 'utf8');
}

module.exports = { buildImportBuffer };
