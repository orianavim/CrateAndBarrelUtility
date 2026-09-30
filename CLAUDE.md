# CrateParser — Crate & Barrel ↔ Grasshopper reconciliation tool

Node.js/Express web app (no framework SPA — single `public/index.html`). Parses
Crate & Barrel daily files (MXD Delivery orders + MXD ASN trailers), reconciles
them against the Grasshopper Labs API: creates missing orders, cancels orders
not on file, and builds inbound manifests (one per ASN file) plus a
pending-inventory-fulfillment manifest.

## Commands

- `npm start` — run locally (port 3000, `.env` controls `MOCK_MODE`)
- `npm test` — full offline test suite (self-generated fixtures, mock client)
- Deploy: push to GitHub, then on the Lightsail server:
  `cd ~/crateparser && git pull && docker compose up -d --build`
  (Caddy handles TLS; site is https://pulsefinalmiletools.grasshopperlabs.net)

## Layout

- `src/config.js` — env handling. Servers: production/Pulse
  (pulsefinalmile.grasshopperlabs.net), staging (staging.grasshopperlabs.io),
  cbh (cbh.grasshopperlabs.net). Default is ALWAYS Pulse; there is no visible
  env picker — clicking the PulseFinalMile logo cycles Pulse→Staging→CBH.
- `src/parser.js` — XLS parsing, file-type detection by first cell
  ("MXD Delivery CSV" / "MXD CSV for ASN"), field helpers, `classifyItemNote`
  (per-row: SRV REQ→service > PICKUP→pickup > delivery), `normSku` (strips
  commas: "164,098" ≡ "164098"), `asnSkuQty` ("Sku Quantity" column).
- `src/grasshopper.js` — real API client + MockGrasshopperClient + status codes.
- `src/reconcile.js` — pure matching engine (quantity-aware FIFO allocation).
- `src/importfile.js` — builds the CSV for the import endpoint (first 4 marker
  rows stripped, formatted values, optional per-segment row filter).
- `src/orderbuilder.js` — hand-built payloads (service tickets, serial numbers,
  zip5 normalization, splitName for "LAST*FIRST").
- `src/server.js` — all endpoints; staged job state in-memory (JOBS map).
- `src/excel.js` — output workbook. `test/run-test.js` — the suite.

## Grasshopper API — hard-won facts (all verified live; do not "fix" these)

- Auth: `POST /api/rest/auth`, client_id/client_secret as HTTP HEADERS (no
  body) → `{access_token, refresh_token, expiration}`. Authorization header is
  the RAW token — NO "Bearer " prefix (Bearer returns 401).
- List orders: `GET /api/orders?status=N&page=P&retailer_id=R`. 25/page, no
  pagination metadata; `per_page`/`ref_order_number`/`created_after` are
  IGNORED, but `retailer_id` filters server-side. Always scope by retailer.
  Client-side ref verification is required on ref searches.
- Create: `POST /api/orders` body `{order, options:{ignore_duplicates:true}}`
  (allows a second order with the same PO#). Line items missing weight default
  to 10 lbs (client-side).
- Import (parse only, NOT persisted): `POST /api/orders/import`, multipart
  field name `file`, CSV. Maps PICKUP→type 2 return; MIS-maps SRV REQ (so
  service tickets are hand-built).
- Order types: 1=delivery, 2=return (RA-prefixed ids), 4=service ticket
  (SVC-prefixed). Service ticket: single line item, name=all Sku Descriptions
  joined ", ", sku=all Skus joined (must be non-empty), category:1 (scalar).
- Returns need a destination: selected Region's hub address injected as
  customer; pickup person name split into freight_info.vendor_info first/last.
- Link return→delivery (split PO): `PATCH
  /api/orders/<returnId>/link?target_order_id=<deliveryId>&type=5` — only when
  BOTH were created in the same run, delivery created first.
- Manifests: `POST /api/manifests` `{type:2, load_type:1, route_id, 
  scheduled_date, arrival_date (MM/DD/YYYY, equal), direction:2,
  destination_region_id}` → `_id`; then `POST /api/manifests/:id/entries`
  `{order_ids, line_items, entry_type:"1"}`.
- Status codes: 1=Pending Arrival, 2=Pending Pickup. TERMINAL (order counts as
  done → PO gets RE-CREATED, split-ship assumption): 5,6,7,9,11,12,18,19,20,28.

## Business rules

- Match key: order `line_item.sku` (commas stripped) ⇄ ASN `Sku` column.
  Master ASN identifies the trailer, not the match key.
- File `Sales#` ⇄ Grasshopper `ref_order_number`.
- Existence is PER SEGMENT (order type), not per PO: a booked return does not
  mean the delivery exists. A PO mixing PICKUP and delivery rows becomes TWO
  orders (delivery first, then return, then link).
- Service level: file LOC→wg (White Glove), CPU→willcall. CPU orders with
  Ship-To "PICKUP*WAREHOUSE": customer name from Directions1 (col AA), phone
  from Phone1 Num else Directions2, digits only.
- serial_number per line item: "OP: <Open Instruction>; ASSMBL:<Assembly
  Instruction>", left-padded with zero-width spaces (U+200B) to 25 chars min.
- Quantity-aware matching: ASN "Sku Quantity" is consumed FIFO (oldest orders
  first); each line item is allocated to ONE ASN file (upload order) → one
  manifest per ASN file, partial (5/8) and split (4+2 across files) supported.
- Unmatched line items → single "-PENDING-INVENTORY-FULFILLMENT" manifest,
  user-reviewed via toggle table (shared-SKU-across-orders rows default OFF).
- Zip codes normalized to 5 digits (strip ZIP+4, restore leading zeros).

## Gotchas

- Sessions/jobs are in-memory: single instance only; restarts log users out.
- Mock mode (`MOCK_MODE=true`) fabricates orders from uploaded files; the
  login screen gains a "Continue in mock mode" option. Never commit real creds;
  users sign in with their own client_id/secret at runtime.
- The desktop-sync/App sandbox used to leave stale `.git/*.lock` files; if git
  complains, `rm -f .git/HEAD.lock .git/index.lock`.
- Sample `.XLS` files in the repo root are untracked test data — keep them out
  of git.
