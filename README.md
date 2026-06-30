# Crate & Barrel · Inbound Manifest Tool

A Node.js web app that reconciles the daily Crate & Barrel order and trailer (ASN)
files against Grasshopper Labs and produces the inbound manifest.

You upload the files, it tells you which pending orders to cancel (and cancels them
after you confirm) and which orders make up the inbound manifest (FIFO).

## Verified API behavior (tested live against staging)

- **Auth:** `POST /api/rest/auth` with `client_id` + `client_secret` as **HTTP headers**
  (no body) → `{ access_token, refresh_token, expiration }`. Authorized calls send the
  token in `Authorization` **raw — NO "Bearer " prefix** (verified cookie-free against
  staging; a `Bearer ` prefix returns 401).
- **List:** `GET /api/orders?status=N&page=P[&retailer_id=R]` → `{ status, data:[...] }`,
  **25 rows/page, no pagination metadata.** The API **ignores** `per_page`,
  `ref_order_number` and `created_after`, but **`retailer_id` DOES filter** server-side.
  The client scopes to one retailer (the C&B account) and fetches pages in parallel
  batches until a short page. Without `retailer_id` it would walk every retailer's orders
  (thousands, minutes); with it, ~hundreds in a few seconds.
- **Order shape (real):** `order_id`, `ref_order_number`, `status`, `created_at`,
  `line_items[].item_id`, `line_items[].sku`.
- **Cancel:** `POST /api/orders/:id/cancel`.
- **Import (order creation):** `POST /api/orders/import`, multipart `upload=<file>`.
  Contract confirmed; see "Open questions" below.

## Sign in first

The utility is gated behind a Grasshopper login. On open you get a sign-in screen:
pick the environment (**Staging** = `staging.grasshopperlabs.io`, **Production** =
`pulsefinalmile.grasshopperlabs.net`), enter your **Client ID** and **Client Secret**.

Auth contract (verified against the Postman collection / a live 200 response):

```
POST {baseUrl}/api/rest/auth
Headers:  client_id: <your id>
          client_secret: <your secret>
(no body)
-> 200 { "access_token": "...", "refresh_token": "...", "expiration": "<ISO 8601>" }
```

Subsequent requests send the token in `Authorization` raw (no "Bearer "). Tokens are refreshed
via `GET /api/rest/get_token` (headers `Authorization` + `refresh_token`), falling back
to a fresh login. The token lives in a server-side session (HttpOnly cookie, 8h); no
credentials are stored in `.env`. When `MOCK_MODE=true`, the screen also offers
"Continue in mock mode" for safe local testing without live API calls.

## What it does

### Either file type, or both

You don't have to upload both files. The tool adapts:
- **Delivery file only** → it only figures out which orders to **create** and **cancel** (no
  manifest, since there's no ASN).
- **ASN file(s) only** → it only **builds the matching manifest** against existing orders (no
  create/cancel, since there's no delivery file to compare against).
- **Both** → the full flow below.

(At least one recognized file is required, or analyze returns an error.)

### Flow (staged wizard)

1. **Retailer + region.** After sign-in set the Retailer ID (saved in a cookie) and pick a
   **Region** from a dropdown loaded live from `GET /api/region`.
2. **Step 1 — Upload + Analyze** (`POST /api/analyze`, no side effects): determines which
   delivery POs already exist (pending, or confirmed via exact `ref_order_number` search so
   a PO that exists in *any* status is never re-created) and which are missing.
3. **Step 2 — Orders & status (live dashboard).** Analyze returns a **unified PO table**
   (`pos`): every delivery PO with its state — `matched` (already in Grasshopper, shows the
   looked-up **order_id**) or `pending_create` — plus the to-cancel orders as
   `pending_cancel`. Each PO also shows a **Type** (Delivery / Pickup) based on whether any
   of its lines has `PICKUP` in the `Item Note` column. The PO column is width-capped (100px)
   with ellipsis. The table has **filters**: Matching orders, Pending creation, Pending
   cancellation, Failed to create. The **Type** is `Service` when any line has
   `SRV REQ` in `Item Note` (takes precedence over Pickup), `Pickup` for `PICKUP`,
   else `Delivery`.

   **Service tickets → type 4.** A PO whose `Item Note` contains `SRV REQ` is created
   as a **service ticket** (`type: 4`). The import endpoint mis-maps these to type-2
   returns with split line items, so the ticket is built from the delivery file
   directly: a **single** line item with `name` = every `Sku Description` joined with
   `", "`, `sku` = every `Sku` joined with `", "` (the API rejects an empty sku), and
   `category: 1`. Service tickets get `SVC`-prefixed order ids. Verified live
   against staging.

   **Pickups → return orders.** When a PO is a pickup, the import endpoint already maps it to
   a **return order** (`type: 2`): the file's Ship-To becomes the pickup location. The return
   needs a destination, which the file doesn't have — so the **selected Region's hub address**
   (from the Region dropdown) is injected as the return destination's `customer.address`.
   A region must be selected when the file contains pickups. Return orders get `RA`-prefixed
   order ids. Verified live against staging.

   Clicking **Create N orders** drives creation client-side, one PO at a time, so the table
   updates live: the row being created is highlighted with state "Creating…", then flips to
   **Created** with its order_id + created_at, or **Failed** (red row) with the error. A
   failure summary appears below the table. Endpoints:
   - `POST /api/create-prepare` — sends the missing-orders CSV to `POST /api/orders/import`,
     which **parses** (does not persist) into mapped order objects, cached server-side.
   - `POST /api/create-one {ref}` — creates one order via `POST /api/orders` after injecting
     `retailer.identifier` and stripping the transient `_id`/`status`. Returns order_id +
     created_at, or the error. Created orders land in status 1 so matching picks them up.

   Each order's full JSON payload + result is added to the searchable decision log (kind
   `create`). All verified live against the C&B staging account.
4. **Step 3 — Cancel.** Prompts to cancel pending orders not on the file (selectable
   checkboxes) via **Cancel selected** or **Skip & continue**.
5. **Step 4 — Match** (`POST /api/match`): matches SKUs against all existing orders (FIFO,
   line-item level) and shows the manifest. **PICKUP exclusion:** delivery line entries
   whose `Item Note` contains `PICKUP` are ignored for fulfillment matching.
6. **Step 5 — Create the inbound manifest in Grasshopper** (optional, alongside the Excel
   download). Enter a manifest name (→ `route_id`) and an inbound date (defaults to today;
   `scheduled_date` = `arrival_date`). `POST /api/build-manifest` then:
   - creates the manifest via `POST /api/manifests` (`type:2`, `direction:2`, dates as
     `MM/DD/YYYY`) and takes its `_id`;
   - adds every matched order + line item via `POST /api/manifests/{_id}/entries`
     (`order_ids` = all matched orders, `line_items` = all matched line-item ids,
     `entry_type:"1"`).
   Both endpoints verified live.

The decision log records how many orders already existed and how many were created.

---

1. **Detects file types** from the first cell of each upload:
   - `MXD Delivery CSV` → the order file (orders that should exist in the system)
   - `MXD CSV for ASN` → an inbound trailer (1–3 of these, merged together)
2. **Pulls pending orders** from Grasshopper — every order in status
   `1` (Pending Arrival) or `2` (Pending Pickup).
3. **Cancel list** = pending Grasshopper orders whose reference is **not** on the
   delivery file. Order match is on `Sales#` (file) ⇄ `ref_order_number` (Grasshopper).
   These are previewed; nothing is cancelled until you click confirm.
4. **Inbound manifest** = pending orders that are on the delivery file **and** carry a
   line item whose **product SKU** is arriving on a trailer. Matching is product-SKU to
   product-SKU: the order's `line_item.sku` (commas stripped) against the `Sku` column in
   the ASN files. Sorted **oldest → newest (FIFO)**. Output is at the **line-item level**:
   one row per matched line item with `FIFO #`, `Order #`, `Order ID`, `Line Item #`,
   `SKU`, `Trailer`, `Fully Fulfilled` (whether every line item on the order is inbound),
   `Items Matched` (e.g. `1/2`), status. To-be-cancelled orders are excluded.

   The **To Cancel** list shows Order #, Created, Customer Name and Status, with a
   checkbox per row — you select which orders to cancel and can cancel in multiple
   batches (already-cancelled orders are skipped).
5. **Output** = a downloadable `.xlsx` with three tabs: Summary, Inbound Manifest
   (line items), To Cancel.

### Retailer scope (saved on the device)

Order lookups are scoped to one retailer via the API's `retailer_id` filter. You set the
Retailer ID **on the main screen after signing in**; it's saved in a persistent browser
cookie (`cb_retailer_id`) and reused automatically — it is not part of login. It's sent
with each analyze and applied to the order listing. `GH_RETAILER_ID` in `.env` is an
optional server-side fallback.

## Key assumptions (change in code if wrong)

- File `Sales#` maps to Grasshopper `ref_order_number`. → `src/parser.js` `deliveryOrderRef()`
- Match key is **product SKU**: order `line_item.sku` (commas stripped) vs the ASN file
  `Sku` column. Master ASN identifies the trailer, not the match key. → `src/reconcile.js`
- Manifest excludes orders that are in the cancel list. → `src/reconcile.js`
- FIFO = all matching orders sorted by `created_at` ascending, no quantity cap.
- Scope: read / cancel / manifest only. The tool does not create orders via
  `/api/orders/import` (orders are created upstream).

## Setup (local)

```bash
npm install
cp .env.example .env      # then edit .env
npm start                 # http://localhost:3000
```

By default `MOCK_MODE=true`, so it never calls Grasshopper. In mock mode the app
fabricates a realistic set of pending orders from the files you upload (including a
few "ghost" orders to populate the cancel list) so you can test the whole flow safely.

## Going live

Set `MOCK_MODE=false` in `.env` and restart. Users then must sign in with real
Grasshopper credentials and choose the environment on the login screen — there are
no credentials in `.env`.

Built-in environment URLs (no trailing slash):

| Env | URL |
| --- | --- |
| Staging / testing | `https://staging.grasshopperlabs.io` |
| Production | `https://pulsefinalmile.grasshopperlabs.net` |

The app authenticates with `POST /api/token/`, caches the bearer token, lists orders
with `GET /api/orders/?status=...`, and cancels with `POST /api/orders/{id}/cancel/`.
If any of the three GH_* values is missing it forces mock mode rather than half-calling
production.

## Tests

```bash
npm test
```

Runs the parser, mock Grasshopper client, reconciliation and Excel builder against the
real sample `.XLS` files in the project root and asserts FIFO ordering, cancel-list and
manifest correctness. Writes `test/sample-output.xlsx`.

## Deploy (Docker, when ready)

```bash
docker build -t crate-asn-tool .
docker run -p 3000:3000 --env-file .env crate-asn-tool
```

## Project layout

```
src/
  config.js       env + mode handling
  parser.js       .XLS parsing + file-type detection + field mapping
  grasshopper.js  real API client + mock client + status constants
  reconcile.js    cancel-list + FIFO manifest logic (pure, unit-testable)
  excel.js        builds the .xlsx output
  server.js       Express server + endpoints
public/index.html upload UI: analyze → review → download / confirm-cancel
test/run-test.js  end-to-end smoke test in mock mode
```

## Endpoints

- `POST /api/analyze` — multipart upload, returns preview (no mutations)
- `POST /api/confirm-cancel` — `{ jobId }`, cancels the cancel-list orders
- `GET  /api/download/:jobId` — the manifest workbook
- `GET  /api/health` — mode + base URL
