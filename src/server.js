'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('./config');
const { parseBatch, deliveryOrderRef, asnTrailerId, normSku, classifyItemNote } = require('./parser');
const { GrasshopperClient, MockGrasshopperClient } = require('./grasshopper');
const { reconcile, orderToRow } = require('./reconcile');
const { buildWorkbook } = require('./excel');
const { buildImportBuffer } = require('./importfile');
const { buildServiceTicket, buildSerialNumber, splitName } = require('./orderbuilder');

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

// ---------------------------------------------------------------------------
// Minimal cookie + session handling (single instance; fine for "local first").
// ---------------------------------------------------------------------------
const SESSIONS = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const COOKIE = 'cb_sid';

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const s = SESSIONS.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    SESSIONS.delete(sid);
    return null;
  }
  return { sid, ...s };
}

function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Not authenticated', needLogin: true });
  req.session = s;
  next();
}

// ---------------------------------------------------------------------------
// In-memory job store with TTL.
// ---------------------------------------------------------------------------
const JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
function putJob(job) {
  JOBS.set(job.id, job);
  setTimeout(() => JOBS.delete(job.id), JOB_TTL_MS).unref?.();
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------
app.get('/api/session', (req, res) => {
  const s = getSession(req);
  res.json({
    authenticated: !!s,
    email: s ? s.email : null,
    env: s ? s.env : null,
    mock: s ? !!s.mock : false,
    mockAvailable: config.mockMode,
    envs: Object.keys(config.envs),
    defaultEnv: config.defaultEnv,
  });
});

app.post('/api/login', async (req, res) => {
  const body = req.body || {};
  const clientId = body.clientId || body.email; // Grasshopper client_id
  const clientSecret = body.clientSecret || body.password; // Grasshopper client_secret
  const retailerId = (body.retailerId || config.retailerId || '').trim();
  const { env, mock } = body;
  const envKey = env && config.envs[env] ? env : config.defaultEnv;
  const baseUrl = config.resolveBaseUrl(envKey);

  try {
    let session;
    if (mock) {
      if (!config.mockMode) return res.status(400).json({ error: 'Mock mode is disabled on this server.' });
      session = { email: clientId || 'mock-user', env: envKey, baseUrl, retailerId, mock: true, client: null, createdAt: Date.now() };
    } else {
      if (!clientId || !clientSecret) return res.status(400).json({ error: 'Client ID and Client Secret are required.' });
      const client = new GrasshopperClient({ baseUrl, clientId, clientSecret, retailerId });
      await client._login(); // throws on bad credentials / unreachable host
      session = { email: clientId, env: envKey, baseUrl, retailerId, mock: false, client, createdAt: Date.now() };
    }
    const sid = crypto.randomBytes(18).toString('hex');
    SESSIONS.set(sid, session);
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ authenticated: true, email: session.email, env: envKey, mock: !!session.mock });
  } catch (err) {
    res.status(401).json({ error: `Grasshopper sign-in failed: ${err.message}` });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req)[COOKIE];
  if (sid) SESSIONS.delete(sid);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, mockMode: config.mockMode }));

// Active regions for the dropdown.
app.get('/api/regions', requireAuth, async (req, res) => {
  try {
    const client = req.session.mock ? new MockGrasshopperClient({ delivery: [], asn: [] }) : req.session.client;
    const regions = await client.listRegions();
    res.json({ regions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Tool endpoints (all require an authenticated Grasshopper session)
// ---------------------------------------------------------------------------
// Map the delivery file's "Service Level" code to a Grasshopper service_level.
//   LOC -> wg (White Glove) · CPU -> willcall (customer pickup / Will Call)
// Anything else keeps whatever the import parser assigned.
const SERVICE_LEVEL_MAP = { LOC: 'wg', CPU: 'willcall' };

function fmtDate(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

// Segment order for display/creation.
const SEGMENT_ORDER = ['delivery', 'pickup', 'service'];

// Group a PO's delivery rows into segments by per-row Item Note classification.
// Returns { present: [seg,...] in stable order, rowsBySeg: { seg: [rows] } }.
// A PO with both PICKUP and non-PICKUP rows yields two segments → two orders.
function segmentize(rows) {
  const rowsBySeg = {};
  for (const r of rows || []) {
    const seg = classifyItemNote(r['Item Note']);
    (rowsBySeg[seg] = rowsBySeg[seg] || []).push(r);
  }
  const present = SEGMENT_ORDER.filter((s) => rowsBySeg[s] && rowsBySeg[s].length);
  return { present, rowsBySeg };
}

// Rows of one PO belonging to one segment.
function segmentRows(delivery, ref, segment) {
  return (delivery || []).filter(
    (rec) => (deliveryOrderRef(rec) || '').trim() === ref && classifyItemNote(rec['Item Note']) === segment
  );
}

// Manifest name: "C&B - Inbound - <unique Trailer Ids from the ASN file>".
function manifestNameFromAsn(asn) {
  const trailers = [...new Set((asn || []).map(asnTrailerId).filter(Boolean))];
  return `C&B - Inbound - ${trailers.join(', ')}`;
}

// STEP 1 — Analyze: figure out which orders need to be created and which are to
// be cancelled. NO side effects (no import, no cancel, no matching yet).
app.post('/api/analyze', requireAuth, upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const parsed = parseBatch(req.files);
    const hasDelivery = parsed.delivery.length > 0;
    const hasAsn = parsed.asn.length > 0;
    if (!hasDelivery && !hasAsn) {
      return res.status(400).json({
        error: 'No recognized files. Upload an MXD Delivery file (orders), MXD ASN file(s) (trailers), or both.',
        fileSummary: parsed.summary,
        warnings: parsed.warnings,
      });
    }

    const retailerId = (req.body && req.body.retailerId ? String(req.body.retailerId) : config.retailerId || '').trim();
    const retailerIdentifier = (req.body && req.body.retailerIdentifier ? String(req.body.retailerIdentifier) : '').trim();
    const regionId = (req.body && req.body.regionId ? String(req.body.regionId) : '').trim();
    const client = req.session.mock
      ? new MockGrasshopperClient({ delivery: parsed.delivery, asn: parsed.asn })
      : req.session.client;
    if (!req.session.mock) client.retailerId = retailerId;

    const pending = await client.listPendingOrders();
    const deliveryRefs = [...new Set(parsed.delivery.map(deliveryOrderRef).filter(Boolean))];
    const deliverySet = new Set(deliveryRefs);
    const pendingByRef = new Map(pending.map((o) => [(o.ref_order_number || '').trim(), o]));

    // Delivery rows grouped by PO (for customer / item count).
    const rowsByRef = new Map();
    for (const rec of parsed.delivery) {
      const r = deliveryOrderRef(rec);
      if (!r) continue;
      if (!rowsByRef.has(r)) rowsByRef.set(r, []);
      rowsByRef.get(r).push(rec);
    }

    // Existence: pending POs exist; for the rest, look up order_id via ref search.
    const candidates = deliveryRefs.filter((r) => !pendingByRef.has(r));
    const foundMap = req.session.mock ? new Map() : await client.findOrderIdsByRef(candidates);
    const toCreateRefs = candidates.filter((r) => !foundMap.has(r));
    const existingCount = deliveryRefs.length - toCreateRefs.length;

    // Unified PO list for the dashboard: every delivery PO (matched w/ order_id,
    // or pending creation) plus the to-cancel orders.
    const serviceLevelByRef = {};
    const typeByRef = {};
    const segTypesByRef = {};
    const pos = [];
    let toCreateUnits = 0;
    for (const ref of deliveryRefs) {
      const rows = rowsByRef.get(ref) || [];
      const first = rows[0] || {};
      serviceLevelByRef[ref] = String(first['Service Level'] || '').trim().toUpperCase();
      // Per-row classification: a PO can mix segments (some PICKUP rows, some
      // delivery). Each present segment becomes its own order.
      //   service ("SRV REQ") → type 4 service ticket
      //   pickup  ("PICKUP")  → type 2 return order
      //   delivery            → type 1 delivery
      const { present, rowsBySeg } = segmentize(rows);
      segTypesByRef[ref] = present;
      // Representative type for a single matched row (precedence service>pickup>delivery).
      const repType = present[present.length - 1] || 'delivery';
      typeByRef[ref] = repType;
      const baseOf = (type, itemCount) => ({
        po: ref,
        customer: String(first['Ship To Cust Name'] || '').trim(),
        items: itemCount,
        type,
        delivery_date: fmtDate(first['Delivery Date']),
        error: null,
        created_at: null,
      });
      if (pendingByRef.has(ref)) {
        pos.push({ ...baseOf(repType, rows.length), order_id: pendingByRef.get(ref).order_id, state: 'matched' });
      } else if (foundMap.has(ref)) {
        pos.push({ ...baseOf(repType, rows.length), order_id: foundMap.get(ref), state: 'matched' });
      } else {
        // Pending creation: one row per segment so a split PO shows two orders.
        for (const seg of present) {
          pos.push({ ...baseOf(seg, rowsBySeg[seg].length), segment: seg, order_id: null, state: 'pending_create' });
          toCreateUnits += 1;
        }
      }
    }

    // To-cancel: pending orders not on today's delivery file — only when a
    // delivery file was uploaded (otherwise we can't tell what to cancel).
    const toCancelRows = hasDelivery
      ? pending.filter((o) => !deliverySet.has((o.ref_order_number || '').trim())).map(orderToRow)
      : [];
    for (const o of toCancelRows) {
      pos.push({ po: o.ref_order_number, order_id: o.order_id, state: 'pending_cancel', type: '', customer: o.customer, items: '', error: null, created_at: o.created_at });
    }

    const deliveryBuffers = req.files
      .filter((f, i) => parsed.summary[i] && parsed.summary[i].type === 'delivery')
      .map((f) => f.buffer);

    const job = {
      id: crypto.randomBytes(8).toString('hex'),
      sid: req.session.sid,
      createdAt: Date.now(),
      client,
      mock: !!req.session.mock,
      parsed,
      deliveryBuffers,
      retailerId,
      retailerIdentifier,
      regionId,
      region: null,
      serviceLevelByRef,
      typeByRef,
      segTypesByRef,
      toCreateRefs,
      toCancel: toCancelRows,
      parsedByRef: null,
      parsedByUnit: {},
      cancelStatusById: {},
      counts: { deliveryTotal: deliveryRefs.length, existing: existingCount, toCreate: toCreateUnits, toCancel: toCancelRows.length },
      created: { count: 0, failed: 0, results: [] },
      result: null,
    };
    putJob(job);

    const log = [{ kind: 'info', text: `Loaded ${pending.length} pending order(s) for this retailer.` }];
    if (hasDelivery) {
      log.push({
        kind: 'info',
        text: `Delivery file has ${deliveryRefs.length} PO(s): ${existingCount} already exist in Grasshopper, ${toCreateUnits} order(s) to create. ${toCancelRows.length} pending order(s) are not on the file.`,
      });
    } else {
      log.push({ kind: 'info', text: 'No delivery file uploaded — skipping order creation and cancellation; building the manifest only.' });
    }
    if (!hasAsn) {
      log.push({ kind: 'info', text: 'No ASN file uploaded — skipping SKU matching; handling order creation and cancellation only.' });
    }

    res.json({
      jobId: job.id,
      mockMode: job.mock,
      retailerId,
      hasDelivery,
      hasAsn,
      counts: job.counts,
      pos,
      toCancel: toCancelRows,
      fileSummary: parsed.summary,
      warnings: parsed.warnings,
      log,
    });
  } catch (err) {
    console.error('[analyze]', err);
    res.status(500).json({ error: err.message });
  }
});

// STEP 2a — Prepare: parse the missing-orders CSV into mapped order objects
// (import endpoint, NOT persisted) and cache them. Returns the refs to create
// so the client can drive per-PO creation with live UI updates.
app.post('/api/create-prepare', requireAuth, async (req, res) => {
  const job = JOBS.get(req.body.jobId);
  if (!job || job.sid !== req.session.sid) return res.status(404).json({ error: 'Job not found or expired. Re-upload the files.' });
  if (!job.toCreateRefs.length) return res.json({ refs: [] });

  try {
    if (job.mock) return res.json({ refs: job.toCreateRefs });
    if (!job.retailerIdentifier) {
      return res.status(400).json({ error: 'Retailer identifier is required to create orders. Set it in the Account section and re-analyze.' });
    }
    const buf = buildImportBuffer(job.deliveryBuffers, new Set(job.toCreateRefs));
    if (!buf) return res.json({ refs: [] });
    const parsedOrders = await job.client.importOrders(buf);
    job.parsedByRef = new Map(parsedOrders.map((o) => [(o.ref_order_number || '').trim(), o]));

    // Build the per-unit parsed orders (unit = ref + segment). Single-segment,
    // non-service POs reuse the bulk import. Multi-segment POs (e.g. a PO with
    // both PICKUP and delivery rows) are re-imported per segment so each order is
    // cleanly mapped (a pickup segment → a return, a delivery segment → a
    // delivery). Service segments are built at create time, not imported.
    job.parsedByUnit = {};
    for (const ref of job.toCreateRefs) {
      const segs = (job.segTypesByRef && job.segTypesByRef[ref]) || [];
      const nonService = segs.filter((s) => s !== 'service');
      const single = segs.length === 1;
      for (const seg of nonService) {
        const uid = ref + '::' + seg;
        if (single) {
          job.parsedByUnit[uid] = job.parsedByRef.get(ref) || null;
        } else {
          const segBuf = buildImportBuffer(job.deliveryBuffers, new Set([ref]), { keepSegment: seg });
          const arr = segBuf ? await job.client.importOrders(segBuf) : [];
          job.parsedByUnit[uid] = arr[0] || null;
        }
      }
    }

    // If any order to create is a RETURN (pickup segment → type 2), we need the
    // selected Region's address as the return destination.
    const hasReturn = job.toCreateRefs.some((r) => (job.segTypesByRef[r] || []).includes('pickup'));
    if (hasReturn) {
      if (!job.regionId) {
        return res.status(400).json({ error: 'This file has pickups (return orders). Select a Region in the Account section first — its address is used as the return destination.' });
      }
      const regions = await job.client.listRegions();
      const region = regions.find((r) => r.id === job.regionId);
      if (!region || !region.address || !region.address.address1) {
        return res.status(400).json({ error: 'The selected Region has no usable address for return destination.' });
      }
      job.region = { name: region.name, address: region.address, contact_info: region.contact_info };
    }
    res.json({ refs: job.toCreateRefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// STEP 2b — Create ONE order by ref. Returns order_id + created_at on success,
// or the error message. Called repeatedly by the client, one PO at a time.
app.post('/api/create-one', requireAuth, async (req, res) => {
  const job = JOBS.get(req.body.jobId);
  if (!job || job.sid !== req.session.sid) return res.status(404).json({ error: 'Job not found or expired. Re-upload the files.' });
  const ref = String(req.body.ref || '');
  job.created = job.created || { count: 0, failed: 0, results: [] };

  // Which segment of this PO to create. A PO with mixed PICKUP + delivery rows
  // produces two units; the client sends the segment per row. Default to the
  // PO's representative segment for single-segment POs / older clients.
  const segs = (job.segTypesByRef && job.segTypesByRef[ref]) || [];
  let segment = String(req.body.segment || '').trim();
  if (!segment) segment = segs.length ? segs[segs.length - 1] : (job.typeByRef && job.typeByRef[ref]) || 'delivery';

  const finish = (ok, extra) => {
    const row = { ref, segment, ok, ...extra };
    if (ok) job.created.count += 1;
    else job.created.failed += 1;
    job.created.results.push(row);
    return res.json(row);
  };

  if (job.mock) {
    const o = job.client.mockCreateRef(ref);
    return finish(true, { order_id: o ? o.order_id : 'MOCK-' + ref, created_at: new Date().toISOString(), error: null });
  }

  // Service level: map the file's Service Level code (LOC->wg, CPU->willcall).
  const fileSL = (job.serviceLevelByRef && job.serviceLevelByRef[ref]) || '';
  const mappedSL = SERVICE_LEVEL_MAP[fileSL] || 'wg';

  // Rows of THIS segment only (so a split PO builds each order from its own rows).
  const segRows = segmentRows(job.parsed.delivery, ref, segment);

  let payload;
  // SERVICE TICKETS (type 4). Built from the delivery file directly: one line
  // item, name = all Sku Descriptions joined ", ", sku = all Skus joined ", ",
  // category 1.
  if (segment === 'service') {
    if (!segRows.length) return finish(false, { order_id: null, created_at: null, error: 'No delivery rows for this service ticket.' });
    payload = buildServiceTicket(segRows, { retailerIdentifier: job.retailerIdentifier, serviceLevel: mappedSL });
    try {
      const resp = await job.client.createOrder(payload);
      const o = (resp && (resp.data || resp)) || {};
      return finish(true, { order_id: o.order_id || o.id || null, created_at: o.created_at || null, error: null, order: payload });
    } catch (err) {
      return finish(false, { order_id: null, created_at: null, error: err.message, order: payload });
    }
  }

  const parsed = (job.parsedByUnit && job.parsedByUnit[ref + '::' + segment]) || (job.parsedByRef && job.parsedByRef.get(ref));
  if (!parsed) return finish(false, { order_id: null, created_at: null, error: 'No parsed order for this PO segment (run prepare first).' });
  payload = { ...parsed, retailer: { identifier: job.retailerIdentifier } };
  delete payload._id;
  delete payload.status;
  if (SERVICE_LEVEL_MAP[fileSL]) payload.service_level = SERVICE_LEVEL_MAP[fileSL];

  // Return orders (pickup segment → type 2): the Ship-To became the pickup
  // location; fill the destination (customer) with the selected Region's address.
  const isReturn = segment === 'pickup' || String(payload.type) === '2';
  if (isReturn) {
    payload.type = 2;
    if (!job.region || !job.region.address) {
      return finish(false, { order_id: null, created_at: null, error: 'No Region selected for return destination.' });
    }
    const a = job.region.address;
    const ci = job.region.contact_info || {};
    payload.customer = payload.customer || {};
    payload.customer.company = payload.customer.company || job.region.name || 'Returns';
    payload.customer.address = {
      address1: a.address1 || '',
      address2: a.address2 || '',
      city: a.city || '',
      state: a.state || '',
      zip: a.zip || '',
    };
    if (!payload.customer.phone1 || !payload.customer.phone1.number) {
      payload.customer.phone1 = { number: (ci.phone && String(ci.phone)) || '0000000000' };
    }
    if (!payload.customer.email) payload.customer.email = ci.email || 'returns@grasshopperlabs.io';

    // Split the original Ship-To name (the pickup person) into the pickup
    // vendor_info first/last name fields, from this segment's rows.
    const dRow = segRows[0];
    const nm = splitName(dRow && dRow['Ship To Cust Name']);
    payload.freight_info = payload.freight_info || {};
    payload.freight_info.vendor_info = payload.freight_info.vendor_info || {};
    payload.freight_info.vendor_info.first_name = nm.first_name;
    payload.freight_info.vendor_info.last_name = nm.last_name;
  }

  // CPU (customer pickup / will-call) orders. The Ship-To can be a warehouse
  // placeholder that hides the real customer in the Directions columns.
  if (fileSL === 'CPU' && !isReturn) {
    const dRow = segRows[0] || {};
    payload.customer = payload.customer || {};
    if (String(dRow['Ship To Cust Name'] || '').trim().toUpperCase() === 'PICKUP*WAREHOUSE') {
      const nm = splitName(dRow['Directions1']);
      payload.customer.first_name = nm.first_name;
      payload.customer.last_name = nm.last_name;
    }
    // Phone: prefer Phone1 Num, else Directions2 (e.g. "Day:3039378679"). Digits only.
    const onlyDigits = (v) => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
    const phone = onlyDigits(dRow['Phone1 Num']) || onlyDigits(dRow['Directions2']);
    if (phone) payload.customer.phone1 = { number: phone };
  }

  // Per-line-item serial_number = OP + assembly instructions from the matching
  // delivery row (matched by SKU within this segment; fall back to the first row).
  {
    const bySku = new Map();
    for (const r of segRows) {
      const k = normSku(r['Sku']);
      if (!bySku.has(k)) bySku.set(k, []);
      bySku.get(k).push(r);
    }
    for (const li of payload.line_items || []) {
      const q = bySku.get(normSku(li.sku));
      const row = q && q.length ? q.shift() : segRows[0] || {};
      li.serial_number = buildSerialNumber(row);
    }
  }

  try {
    const resp = await job.client.createOrder(payload);
    const o = (resp && (resp.data || resp)) || {};
    return finish(true, { order_id: o.order_id || o.id || null, created_at: o.created_at || null, error: null, order: payload });
  } catch (err) {
    return finish(false, { order_id: null, created_at: null, error: err.message, order: payload });
  }
});

// STEP 4 — Match SKUs against all existing orders and build the manifest.
app.post('/api/match', requireAuth, async (req, res) => {
  const job = JOBS.get(req.body.jobId);
  if (!job || job.sid !== req.session.sid) return res.status(404).json({ error: 'Job not found or expired. Re-upload the files.' });
  try {
    const pending = await job.client.listPendingOrders(); // fresh: includes created, excludes cancelled
    const result = reconcile(pending, job.parsed.delivery, job.parsed.asn);
    const createdCount = job.created ? job.created.count : 0;
    result.log.unshift({
      kind: 'info',
      text: `Orders: ${job.counts.existing} already existed, ${createdCount} newly created (of ${job.counts.toCreate} required).`,
    });
    job.result = result;
    res.json({
      jobId: job.id,
      mockMode: job.mock,
      stats: result.stats,
      asnSkus: result.asnSkus,
      manifestName: manifestNameFromAsn(job.parsed.asn),
      manifest: result.manifest.map((o, i) => ({ fifo_seq: i + 1, ...orderToRow(o) })),
      manifestLines: result.manifestLines,
      log: result.log,
      toCancel: result.toCancel.map(orderToRow),
    });
  } catch (err) {
    console.error('[match]', err);
    res.status(500).json({ error: err.message });
  }
});

// Cancel a chosen subset (or all) of the to-cancel orders. Can be called more
// than once (cancel a few now, more later); already-cancelled orders are skipped.
app.post('/api/confirm-cancel', requireAuth, async (req, res) => {
  const job = JOBS.get(req.body.jobId);
  if (!job || job.sid !== req.session.sid) return res.status(404).json({ error: 'Job not found or expired. Re-upload the files.' });

  const reason = req.body.reason || config.cancelReason;
  job.cancelStatusById = job.cancelStatusById || {};

  const byId = new Map((job.toCancel || []).map((o) => [String(o.order_id), o]));
  // Selected ids if provided, otherwise default to every to-cancel order.
  const requested =
    Array.isArray(req.body.orderIds) && req.body.orderIds.length
      ? req.body.orderIds.map(String)
      : (job.toCancel || []).map((o) => String(o.order_id));
  // Keep only valid to-cancel ids that haven't already been cancelled.
  const targets = requested.filter((id) => byId.has(id) && job.cancelStatusById[id] !== 'cancelled');

  const results = [];
  let success = 0;
  const failures = [];
  for (const id of targets) {
    const order = byId.get(id);
    try {
      await job.client.cancelOrder(id, reason);
      job.cancelStatusById[id] = 'cancelled';
      results.push({ order_id: id, ref_order_number: order.ref_order_number, ok: true });
      success += 1;
    } catch (err) {
      job.cancelStatusById[id] = `error: ${err.message}`;
      results.push({ order_id: id, ref_order_number: order.ref_order_number, ok: false, error: err.message });
      failures.push({ order_id: id, error: err.message });
    }
  }

  job.cancelledTotal = Object.values(job.cancelStatusById).filter((v) => v === 'cancelled').length;
  res.json({
    jobId: job.id,
    mockMode: job.mock,
    requested: targets.length,
    success,
    failed: failures.length,
    totalCancelled: job.cancelledTotal,
    results,
  });
});

// STEP 5 — Create an inbound manifest in Grasshopper and add all matched
// orders + line items to it. Uses the manifest _id from creation for the entries.
app.post('/api/build-manifest', requireAuth, async (req, res) => {
  const job = JOBS.get(req.body.jobId);
  if (!job || job.sid !== req.session.sid) return res.status(404).json({ error: 'Job not found or expired. Re-upload the files.' });
  if (!job.result) return res.status(409).json({ error: 'Run matching first.' });

  const order_ids = [...new Set(job.result.manifest.map((o) => String(o.order_id)))];
  const line_items = job.result.manifestLines.map((l) => l.line_item_id).filter(Boolean);
  if (!order_ids.length) return res.status(400).json({ error: 'No matched orders to add to a manifest.' });

  const routeId = (req.body.routeId && String(req.body.routeId).trim()) || manifestNameFromAsn(job.parsed.asn);
  // Accept YYYY-MM-DD (from the date picker) and format to MM/DD/YYYY for the API.
  let date = String(req.body.date || '').trim();
  const ymd = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) date = `${ymd[2]}/${ymd[3]}/${ymd[1]}`;
  if (!date) {
    const d = new Date();
    date = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  }

  try {
    if (job.mock) {
      return res.json({ manifest_id: 'MOCK-MANIFEST', route_id: routeId, date, orders: order_ids.length, line_items: line_items.length, mock: true });
    }
    const manifestPayload = {
      type: 2,
      load_type: 1,
      route_id: routeId,
      scheduled_date: date,
      arrival_date: date, // same as scheduled per spec
      direction: 2,
    };
    // Destination region = the Region selected at the top of the page.
    if (job.regionId) manifestPayload.destination_region_id = job.regionId;
    const manifest = await job.client.createManifest(manifestPayload);
    const manifestId = manifest._id || manifest.id || (manifest.data && (manifest.data._id || manifest.data.id));
    if (!manifestId) return res.status(500).json({ error: 'Manifest created but no _id was returned.' });

    await job.client.addManifestEntries(manifestId, {
      order_ids,
      stop_number: null,
      entry_type: '1',
      stop_confirmed: null,
      confirmed_with: null,
      geolocation: null,
      line_items,
    });

    res.json({ manifest_id: manifestId, route_id: routeId, date, orders: order_ids.length, line_items: line_items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download/:jobId', requireAuth, (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job || job.sid !== req.session.sid) return res.status(404).json({ error: 'Job not found or expired.' });
  if (!job.result) return res.status(409).json({ error: 'Run matching first.' });

  const meta = { mockMode: job.mock, fileSummary: job.parsed ? job.parsed.summary : [] };
  if (job.cancelStatusById) {
    meta.cancelStatusById = job.cancelStatusById;
    meta.cancelsApplied = job.cancelledTotal || 0;
  }
  const buf = buildWorkbook(job.result, meta);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="inbound-manifest-${stamp}.xlsx"`);
  res.send(buf);
});

// Static last so /api routes win.
app.use(express.static(path.join(__dirname, '..', 'public')));

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Crate & Barrel ASN tool running on http://localhost:${config.port}`);
    console.log(`Mock login available: ${config.mockMode ? 'yes' : 'no'} | Environments: ${Object.keys(config.envs).join(', ')}`);
  });
}

module.exports = app;
