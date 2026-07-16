'use strict';

const XLSX = require('xlsx');

// First-cell markers that identify each file type.
const DELIVERY_MARKER = 'MXD Delivery CSV';
const ASN_MARKER = 'MXD CSV for ASN';

// Column names we expect in each file's real header row. We scan for these so
// the parser does not break if Crate & Barrel adds/removes leading junk rows.
const DELIVERY_HEADER_KEYS = ['Status', 'Sales#', 'Sku'];
const ASN_HEADER_KEYS = ['Trailer Id', 'Master ASN', 'Sku'];

function norm(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function rowsFromBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Array-of-arrays, keep empty cells so column indexes stay stable.
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
}

function detectType(rows) {
  const firstCell = norm(rows[0] && rows[0][0]);
  if (firstCell.startsWith(DELIVERY_MARKER)) return 'delivery';
  if (firstCell.startsWith(ASN_MARKER)) return 'asn';
  // Fallback: scan the first few cells of the first few rows.
  const blob = rows
    .slice(0, 3)
    .map((r) => (r || []).map(norm).join(' '))
    .join(' ');
  if (blob.includes(DELIVERY_MARKER)) return 'delivery';
  if (blob.includes(ASN_MARKER)) return 'asn';
  return 'unknown';
}

// Find the header row index by looking for a row that contains all the keys.
function findHeaderRow(rows, keys) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] || []).map(norm);
    if (keys.every((k) => cells.includes(k))) return i;
  }
  return -1;
}

// Convert an array-of-arrays block (header row + data) into array of objects.
function toObjects(rows, headerIdx) {
  const header = (rows[headerIdx] || []).map(norm);
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    // Skip fully empty rows.
    if (row.every((c) => norm(c) === '')) continue;
    const obj = {};
    header.forEach((h, idx) => {
      if (!h) return;
      const val = row[idx];
      obj[h] = typeof val === 'string' ? val.trim() : val;
    });
    out.push(obj);
  }
  return out;
}

// Parse "YYYY-MM-DD-HH.MM.SS.ffffff" (Crate & Barrel Create Date) -> ISO string.
function parseCreateDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s.toISOString();
  const str = String(s).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})\.(\d+)$/);
  if (m) {
    const [, y, mo, d, h, mi, sec, frac] = m;
    const ms = Number(('0.' + frac) * 1000) || 0;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, Math.round(ms)));
    return isNaN(dt) ? null : dt.toISOString();
  }
  const dt = new Date(str);
  return isNaN(dt) ? null : dt.toISOString();
}

/**
 * Parse one uploaded file.
 * @returns { type, fileName, rows, meta }
 */
function parseFile(buffer, fileName) {
  const rows = rowsFromBuffer(buffer);
  const type = detectType(rows);

  if (type === 'delivery') {
    const hIdx = findHeaderRow(rows, DELIVERY_HEADER_KEYS);
    if (hIdx < 0) throw new Error(`${fileName}: looks like a Delivery file but no header row found`);
    const records = toObjects(rows, hIdx);
    return {
      type,
      fileName,
      records,
      count: records.length,
    };
  }

  if (type === 'asn') {
    const hIdx = findHeaderRow(rows, ASN_HEADER_KEYS);
    if (hIdx < 0) throw new Error(`${fileName}: looks like an ASN file but no header row found`);
    const records = toObjects(rows, hIdx);
    return {
      type,
      fileName,
      records,
      count: records.length,
    };
  }

  return { type: 'unknown', fileName, records: [], count: 0 };
}

/**
 * Parse a batch of uploaded files and group them.
 * @param files [{ buffer, originalname }]
 */
function parseBatch(files) {
  const delivery = []; // delivery file records (flattened)
  const asn = []; // asn file records (flattened, merged)
  const summary = []; // per-file summary
  const warnings = [];

  for (const f of files) {
    let parsed;
    try {
      parsed = parseFile(f.buffer, f.originalname);
    } catch (err) {
      warnings.push(`${f.originalname}: ${err.message}`);
      summary.push({ fileName: f.originalname, type: 'error', count: 0 });
      continue;
    }
    summary.push({ fileName: parsed.fileName, type: parsed.type, count: parsed.count });
    if (parsed.type === 'delivery') {
      for (const r of parsed.records) delivery.push({ ...r, __sourceFile: parsed.fileName });
    } else if (parsed.type === 'asn') {
      for (const r of parsed.records) asn.push({ ...r, __sourceFile: parsed.fileName });
    } else {
      warnings.push(`${f.originalname}: unrecognized file (first cell is not "${DELIVERY_MARKER}" or "${ASN_MARKER}")`);
    }
  }

  return { delivery, asn, summary, warnings };
}

// ---- Field extraction helpers (centralize the column-name dependencies) ----

// The Crate & Barrel order reference that maps to Grasshopper ref_order_number.
function deliveryOrderRef(rec) {
  return norm(rec['Sales#']);
}

function asnMasterAsn(rec) {
  return norm(rec['Master ASN']);
}

// The trailer id on an ASN row.
function asnTrailerId(rec) {
  return norm(rec['Trailer Id']);
}

// Normalize a SKU for matching: drop commas (the order side may be formatted
// like "175,590") and trim. Used on both delivery and ASN sides.
function normSku(v) {
  return String(v === undefined || v === null ? '' : v).replace(/,/g, '').trim();
}

// The product SKU on an ASN row (matched against order line_item.sku).
function asnSku(rec) {
  return normSku(rec['Sku']);
}

// Classify a single delivery row from its "Item Note" value. Precedence:
//   service ("SRV REQ") > pickup ("PICKUP") > delivery (anything else).
// This is per-ROW, so one PO can contain rows of different segments.
function classifyItemNote(note) {
  const n = String(note === undefined || note === null ? '' : note);
  if (/srv\s*req/i.test(n)) return 'service';
  if (/pickup/i.test(n)) return 'pickup';
  return 'delivery';
}

module.exports = {
  parseFile,
  parseBatch,
  detectType,
  parseCreateDate,
  deliveryOrderRef,
  asnMasterAsn,
  asnTrailerId,
  asnSku,
  normSku,
  classifyItemNote,
  DELIVERY_MARKER,
  ASN_MARKER,
};
