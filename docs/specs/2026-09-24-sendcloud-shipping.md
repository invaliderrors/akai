# Sendcloud shipping — pickup-point checkout, labels, bulk printing, tracking — spec

**Status:** 2026-09-24. **Current, not historical** — same carve-out as the other
non-historical files in `docs/superpowers/**`.

**Progress: ✅ Implemented and DEPLOYED 2026-09-25 (plan phases 1–6 + 5b). D2b resolved (UPS
replaces DHL).**

**Implementation plan:** `docs/superpowers/plans/2026-09-24-sendcloud-shipping.md`.

**Request (client, 2026-09-24):** integrate Sendcloud to (1) generate a shipping label for
each order, (2) generate labels in bulk, and (3) at checkout, when a pickup-point method is
selected, let the customer choose a pickup point from a list — reference screenshot: a
selected method card ("DPD Point relais · DPD · 1 à 2 jours · 19,95 €") with, underneath,
"Point de retrait — choisissez votre point relais pour valider la commande" and a radio list
of points (name, street + postcode + city, opening hours per day range).

---

## 1. Evidence ledger — Sendcloud API (v3)

Sources: `https://sendcloud.dev/llms.txt`, the per-area OpenAPI 3.1 specs at
`https://sendcloud.dev/.openapi/v3/<area>/openapi.yaml`, and the help centre. Anything not
confirmable from docs is a **spike gate** in §11, not a fact.

| # | Fact | Source |
|---|---|---|
| S1 | v3 base `https://panel.sendcloud.sc/api/v3`. v2 is in maintenance since 2026-04; `POST /v2/parcels` is closed to accounts created after 2026-04. **Build on v3 only.** | docs/getting-started/api-version-guide |
| S2 | Auth: HTTP Basic, public key : secret key, per "Sendcloud API" integration (or OAuth2 client-credentials, 1 h tokens). The integration has a separate **Service Points** toggle that must be on. | docs/getting-started/authentication |
| S3 | Rate limits: GET 1000/min; writes 100/min, burst 15/s → 429. | docs/getting-started/rate-limits |
| S4 | Errors are JSON:API `{errors:[{status,code,title,detail,source}]}`. | OpenAPI |
| S5 | **No sandbox.** Test with shipping option `sendcloud:letter` (unstamped letter, free or near-free) or create-then-cancel. A failed announcement is not charged. | docs/getting-started/creating-test-labels |
| S6 | `POST /shipping-options` lists options for `from_address`/`to_address`/`parcels[].weight`, filterable by `carrier_code`, `functionalities.last_mile` (`service_point`, `locker`, `home_delivery`…), `to_service_point`. Each option: `code`, `carrier`, `requirements.is_service_point_required`, `requirements.fields` (`to_email`, `to_telephone`…), optional `quotes[]` (merchant **cost**, VAT treatment undocumented). | docs/shipments/shipping-options-and-quotes |
| S7 | `GET /service-points?country_code&carrier_code[]&address|address_postal_code…&radius|bbox&limit≤200` — secret-key auth (backend only). Result: `id` (**integer**), `name`, `carrier{code,name,logo_url}`, `carrier_service_point_id`, `general_shop_type` (`servicepoint`/`locker`/`post_office`), `address{street,house_number,postal_code,city,country_code}`, `position`, `opening_times{monday..sunday: [{start_time,end_time}] | null}` (**actual current week**), `distance` (m), `is_expired`. Plus `geocoding.status` (`matched`/`partially_matched`/`not_found`). **503 when the geocoder is down.** | docs/service-points/find-service-points-with-the-api |
| S8 | `GET /service-points/{id}` and `POST /service-points/{id}/check-availability` → `{is_available}`; Sendcloud says re-check **just before creating the shipment**. | same |
| S9 | `POST /shipments/announce` is synchronous (≤15 parcels), returns the label inline (base64) for single-parcel shipments, and **can return 200 with a failed announcement** — `errors[]` and parcel `status` must be checked. `POST /shipments` is the async variant (≤50). In v3 creating = announcing (label billed at creation). | docs/shipments/create-a-shipment |
| S10 | Shipment body: `from_address{sender_address_id}`, `to_address{name, company_name, address_line_1, house_number, address_line_2, postal_code, city, po_box, country_code, email, phone_number}`, `to_service_point{id: "<string>"}` (**string**, unlike S7), `ship_with{type:"shipping_option_code", properties{shipping_option_code}}`, `parcels[]{weight{value:"1.500",unit:"kg"|"g"}}`, `order_number`, `total_order_price`, **`external_reference_id`** (unique per account; reuse → **409 with the existing object**), `label_details{mime_type, dpi}`. | API reference |
| S11 | Labels: `GET /parcels/{id}/documents/label` (PDF/ZPL/PNG, `paper_size` A4/A5/A6); **bulk** `GET /parcel-documents/label?parcels=…` — **max 20 parcels per request**, one file back. | docs/shipments/print-your-labels |
| S12 | Cancel: `POST /shipments/{id}/cancel` → 200 cancelled / 202 queued / 409 rejected. Carrier-specific deadlines; unused labels credited if cancelled within 42 days (UPS 21). | API reference; help 360025143991 |
| S13 | Webhook "parcel status changed": configured **in the panel** per integration; header `Sendcloud-Signature` = hex HMAC-SHA256 of the raw body keyed with the Webhook Signature Key (or the secret key). No timestamp/replay window. 10 retries (5 min → 1 h). **May arrive out of order.** Payload is the **legacy v2 parcel shape** with a numeric status id. Only fires for parcels created by the same integration. | api/v3/webhooks |
| S14 | Tracking pull: `GET /parcels/tracking/{tracking_number}` → `events[]`, `parent_status`, expected delivery date. Shipment responses carry `tracking_number` + `tracking_url`. | docs/parcel-tracking |
| S15 | No official Node SDK; official OpenAPI specs exist per area. | docs |
| S16 | Plans (Spain, ex-VAT): Lite €35/mo, Growth €109, Premium €219, Pro €799, plus a per-label fee; own carrier contracts need a paid plan; API access on all plans; service-point picker for a *custom system* possibly Growth+ (**unconfirmed**). | help 47637578774929; pricing page |
| S17 | Address limits per carrier: InPost ES / Mondial Relay **require a house number** (≤8 chars); SEUR, GLS ES, InPost ES, Mondial Relay, CTT **require email**; GLS ES and CTT **require phone**. | docs/addresses/address-field-limits |

## 2. Evidence ledger — this codebase

| # | Fact | Where |
|---|---|---|
| C1 | `ShippingZone{countryCodes[]}` + `ShippingRate{name Json, strategy FLAT/WEIGHT/PRICE, priceGross, freeOverSubtotal, …}` — **no carrier, option code or delivery-type fields**. No admin UI; rates come from seed scripts. Live rates: "DHL pickup-point" €19.99 and "InPost pickup-point" €8.99 in ES and EU zones, free ≥ €250. | `schema.prisma:1226-1275`; `seed.ts:364-440` |
| C2 | Quote: `POST /v1/shipping/quote {countryCode, postalCode}` → `options[{rateId, name, priceGross, isFree}]`; weight + subtotal derived server-side from the cart. `postalCode` accepted but unused. | `shipping.controller.ts:91-121`; `libs/contracts/src/lib/shipping.ts` |
| C3 | Checkout sends `shippingMethodId` (= rate id); the server re-resolves it (`ShippingService.resolveCharge`) and stores **only** `Order.shippingMethodName`. The rate id is discarded. | `checkout.service.ts:145-202` |
| C4 | Order has `ship*` address snapshot incl. `shipPhone?`, no weight, no service point. `Shipment{carrier, trackingNumber, trackingUrl, status PENDING/IN_TRANSIT/DELIVERED/RETURNED/LOST}` + `ShipmentItem`. `OrdersService.createShipment` / `markShipmentDelivered` already drive PAID→FULFILLING→SHIPPED→DELIVERED and send `shipping-confirmation` (per parcel) / `delivery-confirmation` emails. | `schema.prisma:1281-1557`; `orders.service.ts:868-1140` |
| C5 | Admin has **no** shipment UI and **no** bulk actions; `DataTable` has no row selection. Customer order detail already renders `shipments` once the API returns them. | dashboard `admin/orders/*`; `components/account/order-detail.tsx` |
| C6 | `fulfilment` module is an empty placeholder; the `order-fulfilment` outbox producer is deliberately commented out in `order-settlement.ts:73-101` ("emit a topic in the same change as its consumer"). Outbox handler pattern: `revalidation.outbox-handler.ts`; registration in `outbox.module.ts:54-76`; 8 attempts, 5 s→15 min backoff. Cron: `ScheduledJobsRunner`. | as cited |
| C7 | Webhook pattern: raw-body middleware per path (`main.ts:82-87`), HMAC template = Resend (`resend-signature.ts`, 503 when unconfigured), dedupe via `ProviderEvent` inserted in the same transaction. | as cited |
| C8 | Config: `libs/config` zod env → `config.whop` transform; optional-vendor precedents (DeepL, Resend webhook secret); `.env.example` cross-checked by a test. | `libs/config/src/schema.ts` |
| C9 | Private object storage exists (S3/MinIO `S3_BUCKET_COA`, hand-rolled SigV4 presigner); the API has never written an object itself. | `media/s3-presigner.ts` |
| C10 | Checkout: email required, **phone optional**, **no separate house-number field**, country list broader than served zones. | `checkout-form.tsx`; `identity.ts:82-96` |
| C11 | `ProductVariant.weightGrams?` exists; parcel weight is computed on the fly, never stored on the order. No sender/warehouse address anywhere. | `schema.prisma:618-622` |

---

## 3. Design decisions (recommended; §12 lists which need the client)

### 3.1 Customer prices stay OURS; Sendcloud decides carriage, not price

The customer is charged our `ShippingRate` price (with the free-over-€250 rule and our VAT
handling), exactly as today. Sendcloud quotes (S6) are the **merchant's cost**, VAT
treatment undocumented, and depend on plan and contracts — charging them would make the
checkout price move with Sendcloud's price list and break "the number we compute is the
number charged". Each rate is instead **mapped** to a Sendcloud shipping option:

- `ShippingRate.sendcloudOptionCode` — e.g. `inpost_es:locker/…` (verified per §11 G1).
- `ShippingRate.deliveryType` — `HOME | SERVICE_POINT`.
- `ShippingRate.carrierCode` — the Sendcloud carrier code used to filter pickup points
  (points of other carriers must never be offered for this method — the reference
  screenshot shows SEUR lockers under a DPD method; we do not reproduce that).
- `ShippingRate.transitDaysMin/Max` — the "1–2 días" sub-line.

A rate without a Sendcloud mapping is still sellable (label made by hand, as today).

### 3.2 Pickup-point list is ours, proxied through our API (not the hosted iframe)

The screenshot is a native list, not a map overlay. S7 needs the **secret** key, so the
browser calls **our** API, which calls Sendcloud:

`POST /v1/shipping/service-points` `{ rateId, countryCode, postalCode, city? }` →
`{ status: "OK" | "ADDRESS_NOT_FOUND" | "NONE_NEARBY" | "UNAVAILABLE", points: [{ id,
name, shopType, street, houseNumber, postalCode, city, countryCode, distanceMeters,
openingHours: { monday: [{from,to}] | null, … } }] }`

- Server resolves the rate → `carrierCode`, calls S7 with `radius` 10 km (widen to 25 km on
  `NONE_NEARBY` once), `limit` 20, drops `is_expired`, maps to our strict contract.
- Throttled like the quote endpoint; short in-memory cache (5 min) keyed by
  `carrier|country|postcode` to stay far inside S3.
- Opening hours are rendered by the storefront (grouping equal consecutive days into
  "Lun–Sáb 09:00–21:30 · Dom 09:30–14:30", as in the reference), all copy translated.
- A 503 from Sendcloud → `UNAVAILABLE`, rendered as "no podemos cargar los puntos, inténtalo
  de nuevo" with a retry, **never** a silent empty list.

### 3.3 Checkout carries the chosen point; the server re-verifies and snapshots it

- `createCheckoutSessionSchema` gains `servicePointId: string | null`.
- If the resolved rate is `SERVICE_POINT`: required; the server fetches it (S8
  `GET /service-points/{id}`), checks `carrier.code === rate.carrierCode`, the country
  matches the shipping address, `is_expired` false, and `check-availability` true. Any
  failure → coded `SERVICE_POINT_UNAVAILABLE` (the storefront asks to pick another).
  If `HOME`: must be null.
- The order snapshots the point (it must survive the point disappearing later):
  `Order.shippingRateId`, `sendcloudOptionCode`, `servicePointId`,
  `servicePointCarrierId`, `servicePointName`, `servicePointAddress` (single line),
  `servicePointPostNumber?`, and `parcelWeightGrams` (computed at checkout from the lines,
  so a later product purge cannot change the label weight).
- The rate id is **no longer discarded** (C3).

### 3.4 Customer contact data needed by carriers

- **Phone becomes required at checkout** (S17: several ES carriers require it; every
  pickup notification depends on it). Validated loosely (7–20 chars of `+ digits spaces`).
- **House number:** InPost ES / Mondial Relay require it separately (S17). Recommended: a
  separate required "Número" field in the checkout address, stored in a new
  `shipHouseNumber` snapshot column, sent as `to_address.house_number`. (Alternative: parse
  it out of line 1 — fragile; rejected.)
- The shipping address is still collected for pickup methods (it is the customer's address
  and the search origin); the label goes to the point.

### 3.5 Labels: one Sendcloud shipment per order, idempotent by order id

A real `fulfilment` module owns everything below (it stops being a placeholder).

- `SendcloudClient` — the only code that speaks HTTP to Sendcloud: Basic auth, v3 base,
  zod-parsed responses (no `any`; wide vendor objects narrowed in the adapter), retry with
  backoff on 429/503, typed `SendcloudError{status, code, detail}`.
- `LabelService.createForOrder(orderId, actorId)`:
  1. Order must be `PAID` (or `FULFILLING` with no active shipment) and have a mapped rate.
  2. `POST /shipments/announce` with `external_reference_id = order.id`,
     `order_number`, `from_address.sender_address_id` (config), `to_address` from the
     snapshot, `to_service_point.id` (string) when present, `ship_with` = option code,
     one parcel `{weight: {value: grams, unit: "g"}}`, `label_details` PDF.
  3. **409** → fetch by `external_reference_id` and continue (idempotent — a retried job
     never buys a second label).
  4. Check `errors[]` / parcel status (S9); failure → shipment row `FAILED` with the
     vendor detail for the admin, order untouched.
  5. Persist a `Shipment` (`provider = SENDCLOUD`, `sendcloudShipmentId`,
     `sendcloudParcelId`, `trackingNumber`, `trackingUrl`, `carrier`, `status =
     LABEL_CREATED`, `labelObjectKey`), store the label PDF in the private bucket
     (`labels/{orderId}/{parcelId}.pdf`, server-side PUT via the existing presigner), and
     move the order PAID → FULFILLING. All shipment lines = all order lines (one parcel per
     order; multicollo is out of scope).
- **Test mode:** when `SENDCLOUD_MODE=test` (default outside the live deployment), the
  option code is replaced by `sendcloud:letter` (S5) so development never buys a real label.
  Mirrors the Whop sandbox/live pin: the live deployment sets `SENDCLOUD_MODE=live`
  explicitly.
- **Cancel:** admin action → `POST /shipments/{id}/cancel` (S12); 200/202 → shipment
  `CANCELLED`, order back to `PAID`; 409 → surfaced ("el transportista ya no permite
  cancelarla").
- **Amendments recorded at implementation (Phase 4–5, 2026-09-24):**
  - `external_reference_id` is `order.id` for the FIRST attempt and `order.id:N` after N
    earlier Sendcloud attempts that ended `CANCELLED` or `FAILED`. A reference is unique
    per account forever (409 returns the existing object), so a plain `order.id` would
    hand a re-label after a cancel the cancelled label. N is derived from our own rows,
    so a retry after a crash between purchase and record still re-sends the SAME
    reference and is healed by the 409.
  - `FULFILLING → PAID` was added to `ORDER_STATUS_TRANSITIONS` for the cancel path only;
    PAID stays non-operator-assignable and the webhook treats a late settlement on a
    FULFILLING order as redundant before consulting the table.
  - Orders with no frozen `parcelWeightGrams` are skipped with a fifth reason,
    `WEIGHT_MISSING`, rather than announced with a guessed weight.
  - Cancel is offered only for `LABEL_CREATED` (once scanned the order is SHIPPED and a
    label cancel cannot un-ship it).

### 3.6 Bulk generation and bulk printing

- Admin orders list gains row selection (checkbox column in `DataTable`) and two actions:
  - **"Generar etiquetas"** — `POST /v1/admin/fulfilment/labels` `{ orderIds[] ≤ 100 }`
    with an `Idempotency-Key`. Enqueues one `order-fulfilment` outbox message per order
    (`{action:"create-label", orderId, actorId}`) and returns immediately with the accepted
    / skipped (already labelled, not PAID, unmapped rate) split. The outbox gives retries,
    backoff and a dead-letter row at `/admin/jobs` for free; S3's 100 writes/min is
    respected by a per-handler throttle.
  - **"Imprimir etiquetas"** — `POST /v1/admin/fulfilment/labels/print` `{ orderIds[] }` →
    one merged PDF of **our stored** label files, in the selected order. Merging our own
    files (not S11's 20-parcel bulk call) means no batching, no vendor dependency at print
    time, and reprints are free. Needs `pdf-lib` (pure JS, no native deps) — the one new
    dependency; justified because PDF concatenation is not something to hand-roll.
- Filters on the list: "Sin etiqueta" (PAID, no active shipment), "Etiqueta creada",
  "En tránsito", "Incidencia".
- Order detail: service point, shipment card (carrier, tracking link, status timeline,
  "Descargar etiqueta", "Cancelar etiqueta", "Reintentar" for FAILED).

### 3.7 Tracking: webhook as a trigger, poll as the safety net

- `POST /v1/webhooks/sendcloud`: raw body; `Sendcloud-Signature` verified as hex
  HMAC-SHA256 with `SENDCLOUD_WEBHOOK_SECRET` (timing-safe; 503 when unconfigured — Resend
  pattern); body zod-parsed loosely for `parcel.id` + `timestamp` only; dedupe via
  `ProviderEvent` id `sendcloud:{parcelId}:{timestamp}`.
- Because the payload is the legacy v2 shape with numeric status ids and may arrive out of
  order (S13), it is **only a trigger**: the handler re-reads the parcel's current state
  from v3 (S14) and applies that — so ordering never matters.
- A cron sweep (every 2 h) re-reads every non-terminal Sendcloud shipment older than 2 h —
  covers lost webhooks and a misconfigured panel.
- State mapping (v3 status/phase → ours): announced/ready to send → `LABEL_CREATED`;
  first carrier scan / in transit → `IN_TRANSIT` (order → SHIPPED, **send
  `shipping-confirmation` with tracking**); awaiting customer pickup → `AWAITING_PICKUP`
  (new; optional "ya está en tu punto de recogida" email — §12); delivered/collected →
  `DELIVERED` (order → DELIVERED, `delivery-confirmation`); returned to sender →
  `RETURNED` (admin alert); cancelled → `CANCELLED`; exception → `EXCEPTION` flag + admin
  alert. The exact v3 code list is spike gate G4.

**As built (Phase 6, `apps/api/src/modules/fulfilment/tracking/`):**

- **Panel setup (once per environment).** Sendcloud panel → Settings → Integrations → the
  "Sendcloud API" integration whose keys are in `SENDCLOUD_PUBLIC_KEY`/`SECRET_KEY` →
  enable webhooks, Webhook URL **`https://api.akai.shop/v1/webhooks/sendcloud`**. If
  the integration shows a Webhook Signature Key, put it in `SENDCLOUD_WEBHOOK_SECRET`;
  otherwise leave that unset and the secret key is used (§11a). Webhooks only fire for
  parcels created by that same integration (S13), so labels must be bought through the
  API, not the panel.
- **Responses.** Sendcloud not configured → the coded `FULFILMENT_NOT_CONFIGURED` (409 +
  `reason`, the foundation's convention — not a 503, see `fulfilment.errors.ts`); raw body
  missing → 400 `RAW_BODY_UNAVAILABLE`; bad/missing signature → 400 `INVALID_SIGNATURE`.
  After the signature holds it is **always 200**: `enqueued`, `duplicate`, `unmatched`
  (no shipment has that parcel id — logged, never retried) or `ignored` (unparsable body
  or an action other than `parcel_status_changed`). With no `timestamp` in the body the
  dedupe id uses a body digest (`sendcloud:{parcelId}:sha256:…`).
- **`shipment-sync` outbox topic** `{shipmentId}` → `ShipmentSyncService.sync`: `GET
  /shipments/{sendcloudShipmentId}`, picks our parcel, maps its v3 code with the §11a table
  (`sendcloud-status.map.ts`, total over the 34 known codes; `UNKNOWN`/new → unchanged +
  warn), moves the shipment **forward only** (terminal never changes; EXCEPTION is
  sideways; CANCELLED/FAILED only before a scan), and always persists
  `sendcloudStatusCode`, `lastSyncedAt` and tracking number/URL.
- **First scan** (first IN_TRANSIT / AWAITING_PICKUP / DELIVERED seen) sets `shippedAt`
  under a `shippedAt IS NULL` guard, walks the order PAID → FULFILLING → SHIPPED via
  `assertTransition` + `applyStatus`, and enqueues one `shipping-confirmation` (with the
  pickup point name/address for pickup orders), scoped by shipment id.
- **AWAITING_PICKUP** → one `ready-for-pickup` (es/en; point, address, the point's
  current-week hours read best-effort from `GET /service-points/{id}`), held back 60 s when
  the same sync also sent the shipping mail so the two arrive in order.
- **DELIVERED** → `OrdersService.markShipmentDelivered(shipmentId, null)` — the staff path.
- **RETURNED / EXCEPTION** → internal order event + a `notifications` outbox row (the Whop
  mismatch alert channel; it dead-letters visibly at /admin/jobs until the notifications
  module ships) + error log.
- **CANCELLED / FAILED reported by Sendcloud** (e.g. cancelled in the panel) → shipment
  stops carrying goods; a FULFILLING order with nothing else in flight walks back to PAID
  over the FULFILLING → PAID edge.
- **Sweep:** `shipment-sync-sweep` in `ScheduledJobsRunner`, every 2 h, enqueues syncs for
  up to 200 non-terminal SENDCLOUD shipments whose `lastSyncedAt` is null or > 2 h old.

### 3.8 Config (`libs/config`)

`SENDCLOUD_PUBLIC_KEY`, `SENDCLOUD_SECRET_KEY`, `SENDCLOUD_WEBHOOK_SECRET`,
`SENDCLOUD_SENDER_ADDRESS_ID` (int), `SENDCLOUD_MODE` (`test`|`live`, explicit on the live
deployment, defaulting to `test`). All optional as a set: absent → the fulfilment module
binds a NOT_CONFIGURED client (label actions return a coded 503, service-point search
returns `UNAVAILABLE`, checkout of a `SERVICE_POINT` rate is refused with a clear code) —
the DeepL precedent. Partially set → boot fails. Resolved once into `config.sendcloud`;
nothing else reads the env. Keys stay out of `LOGGABLE_KEYS`.

### 3.9 Storage

A dedicated private bucket `S3_BUCKET_LABELS` (or `labels/` prefix in the COA bucket — §12
D9). The API writes objects server-side for the first time (PUT via the existing SigV4
presigner); reads are short-lived presigned GETs, admin-only.

---

## 4. Data model changes (one migration)

- `ShippingRate`: `deliveryType` (`HOME`|`SERVICE_POINT`, default `HOME`),
  `carrierCode varchar(64)?`, `sendcloudOptionCode varchar(128)?`, `transitDaysMin int?`,
  `transitDaysMax int?`.
- `Order`: `shippingRateId uuid?` (FK, set null), `sendcloudOptionCode?`,
  `servicePointId varchar(32)?`, `servicePointCarrierId varchar(64)?`,
  `servicePointName varchar(120)?`, `servicePointAddress varchar(255)?`,
  `servicePointPostNumber varchar(32)?`, `shipHouseNumber varchar(16)?`,
  `parcelWeightGrams int?`.
- `Shipment`: `provider` (`MANUAL`|`SENDCLOUD`, default `MANUAL`),
  `sendcloudShipmentId varchar(64)? unique`, `sendcloudParcelId bigint? unique`,
  `labelObjectKey varchar(512)?`, `failureReason text?`, `lastSyncedAt timestamptz?`.
- `ShipmentStatus` += `LABEL_CREATED`, `AWAITING_PICKUP`, `CANCELLED`, `FAILED`,
  `EXCEPTION`.

Existing orders keep nulls and remain manually fulfillable.

## 5. API surface

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/shipping/quote` | public | unchanged request; options gain `deliveryType`, `carrierName`, `transitDaysMin/Max` |
| `POST /v1/shipping/service-points` | public, throttled | §3.2 |
| `POST /v1/checkout` | public | + `servicePointId` (§3.3), phone + house number required |
| `POST /v1/admin/fulfilment/labels` | STAFF/ADMIN, idempotent | bulk/single generate (§3.6) |
| `POST /v1/admin/fulfilment/labels/print` | STAFF/ADMIN | merged PDF |
| `GET /v1/admin/fulfilment/shipments/:id/label` | STAFF/ADMIN | 302 to a short-lived signed URL |
| `POST /v1/admin/fulfilment/shipments/:id/cancel` | STAFF/ADMIN | §3.5 |
| `POST /v1/admin/fulfilment/shipments/:id/retry` | STAFF/ADMIN | re-enqueue a FAILED label |
| `POST /v1/webhooks/sendcloud` | signature | §3.7 |
| order DTOs (admin + customer) | — | + shipping method, service point, shipments[] |

## 6. Storefront

- Checkout method card: name, carrier · "1–2 días", price / "Gratis" (existing radio,
  restyled like the reference).
- When the selected rate is `SERVICE_POINT`: a "Punto de recogida" panel below it, loaded
  from §3.2 using the entered postcode (debounced, re-queried when postcode/country
  change), radio list with name, address, grouped hours, distance; the submit button
  stays disabled with "Elige un punto de recogida para continuar" until one is picked.
  States: loading skeleton, `NONE_NEARBY`, `ADDRESS_NOT_FOUND` ("revisa el código postal"),
  `UNAVAILABLE` + retry. Mobile-first, keyboard accessible (native radios, fieldset +
  legend).
- New required fields: phone, house number (es/en copy, validation messages).
- Order confirmation / processing page shows the chosen point.
- All copy in `messages/{es,en}.json`; server messages never rendered.

## 7. Dashboard

- Orders list: selection column, "Generar etiquetas", "Imprimir etiquetas", shipping
  status column and filters, result toast (N creadas, M omitidas + motivo).
- Order detail: service point block, shipment card (§3.6), manual shipment still possible
  for unmapped rates.
- Shipping zones and rates are editable (§7a); a seed script sets the initial Sendcloud
  mappings from §11a.

## 7a. Shipping zones and rates admin (D8)

`/admin/shipping` in the dashboard, STAFF/ADMIN only:
- Zones: list/create/edit/delete (soft) — name, countries (multi-select from the served
  country list; a country may belong to one active zone only — enforced server-side),
  sort order.
- Rates per zone: create/edit/deactivate/delete (soft) — name es/en, strategy
  (FLAT/WEIGHT/PRICE) with min/max bounds, price (minor units via `libs/money` inputs),
  free-over threshold, active flag, and the Sendcloud mapping: delivery type, carrier,
  option code (a select populated live from `POST /shipping-options` for the zone's first
  country, with a free-text fallback), transit days.
- API: `/v1/admin/shipping/zones` + `/zones/:id/rates` CRUD, strict zod DTOs, audit
  fields, revalidation of nothing (quotes are live) but the free-shipping threshold read
  reflects changes immediately; a `GET /v1/admin/shipping/sendcloud-options?country=`
  helper proxies S6.
- The marquee's "250 €" copy is pinned to the seeded constant by a test; once the
  threshold is editable that test moves to a warning in the admin UI when a rate's
  threshold differs from the advertised figure.

**As built (Phase 5b):** `AdminShippingModule` (`apps/api/src/modules/shipping/admin/`),
STAFF/ADMIN read and write (the categories/discounts precedent). Zone writes take one
transaction-scoped advisory lock before the overlap check, so two editors racing for a
country cannot both win (proven against Postgres in `api-e2e/admin-shipping.spec.ts`).
Refusals carry `shippingAdminFailureReasonSchema` reasons. **Tax decision:** a zone may
only GAIN a country that already has a current STANDARD `tax_rate` row — refused with
`TAX_RATE_MISSING`, never auto-created: the seed's VAT figures are a per-country table,
not a default, so any rate the editor invented would be a guess. The served-country list
moved to `@akai/contracts` (`DESTINATION_COUNTRY_CODES`, re-exported by the storefront);
the advertised figure is `ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR`, pinned to the seed
constant by a test. Rate names: Spanish required, English optional (falls back to es).

## 8. Emails

- `shipping-confirmation` fires on the first in-transit scan (not at label creation), with
  tracking number/URL and, for pickup orders, the point name/address.
- `delivery-confirmation` on delivered/collected.
- Optional new `ready-for-pickup` (§12 D6).

## 9. Security and correctness invariants

- Secret key never reaches a browser; the storefront talks only to our API.
- The price charged is always our computed rate; nothing from Sendcloud or the client sets
  an amount.
- A label is bought at most once per order (`external_reference_id` + 409 handling +
  unique `sendcloudShipmentId`).
- The service point on the label is the one re-verified at checkout and snapshotted.
- Webhooks: signature before parse; dedupe in the same transaction as the state change;
  state always re-read from v3.

## 10. Tests

Unit: client adapter (auth header, retry, error mapping, zod narrowing), opening-hours
grouping, rate mapping, checkout validation of `servicePointId` (wrong carrier, expired,
unavailable, HOME with a point), label service (happy path, 409 reuse, 200-with-failure,
test-mode letter override), webhook signature + dedupe + out-of-order safety, state
mapping, bulk skip rules, PDF merge order. api-e2e (Postgres + a fake Sendcloud HTTP server
on a local port): checkout → PAID → bulk generate → webhook in-transit → SHIPPED + email
→ delivered. Storefront: point panel states, submit gating, hours rendering. Dashboard:
selection + bulk actions, order detail shipment card.

## 11. Spike gates (verify on the real account before building the dependent phase)

| Gate | Question | Failure direction |
|---|---|---|
| G1 | Which pickup options exist **from ES** to each served country (`POST /shipping-options`, `from ES`, `last_mile: service_point|locker`)? Their `code`s and carriers. | Rates without a viable option stay manual / are withdrawn per country. |
| G2 | Does `GET /service-points` work on the account's plan (S16 says custom-system picker may be Growth+)? | If not: upgrade, or fall back to the hosted picker (public key, iframe; CSP entries). |
| G3 | Are quotes/labels charged for `sendcloud:letter` on this account? | If charged: test with create-then-cancel only. |
| G4 | Exact v3 parcel status codes / tracking phases for the §3.7 mapping. | Unknown codes map to `IN_TRANSIT` + logged, never to DELIVERED. |
| G5 | Does A6 PDF per label print correctly on the client's printer; do they want A4 4-up? | Adjust `paper_size` at download. |

## 11a. Spike results (real account, 2026-09-24)

- **Sender address** existed on the PREVIOUS shop's Sendcloud account (details
  redacted). Akai must create its own and set `SENDCLOUD_SENDER_ADDRESS_ID`. The option
  table below is from that previous account too — re-run the spike on Akai's.
- **G1 — options from ES (500 g):** the account has **InPost ES** and **UPS** only (plus
  `sendcloud:letter`). **There is no DHL** — today's "DHL pickup-point" rate has no carrier
  behind it.

  | To | InPost pickup | UPS Access Point | other |
  |---|---|---|---|
  | ES | `inpost_es:service_point,national_c2c` (needs email) | `ups:standard/service_point` €6.00 | — |
  | PT, FR, IT, NL, BE | `inpost_es:service_point,international_c2c` (needs email) | `ups:standard/service_point` (needs email + phone) | — |
  | DE | same InPost code | same UPS code | `inpost_es:home_international_c2c` (home) |
  | IE | **not available** | `ups:standard/service_point` €14.10 | — |

  The InPost option **code differs between national and international**, so the mapping is
  per rate, and rates are per zone — the ES/EU zone split already matches. **IE must get
  its own zone** (UPS only) or InPost would be offered where it cannot be shipped.
- **G2 — service points work on this plan**: `GET /service-points` returned InPost and UPS
  points for 50002 Zaragoza (incl. "PAPELERIA PILI" from the reference screenshot).
  Opening hours can hold **several shifts per day** (08:00–14:00, 17:00–20:30);
  `house_number` may be `""`; `general_shop_type` distinguishes `servicepoint`/`locker`.
- **G3 — `sendcloud:letter`** announce returned `READY_TO_SEND`, tracking number + URL and
  an inline A6 PDF; re-posting the same `external_reference_id` → **409 with the full
  existing shipment** (same shape, label included); `GET /parcels/{id}/documents/label` and
  the bulk endpoint both return `application/pdf`; cancel → **202 queued**. Note: for the
  letter product Sendcloud merged `house_number` into `address_line_1`.
- **G4 — v3 status codes** (`GET /parcels/statuses`): READY_TO_SEND, ANNOUNCED,
  ANNOUNCING, TO_SORTING, SORTING, SORTED, UNSORTED, AT_SORTING_CENTRE, SHIPMENT_ON_ROUTE,
  DRIVER_ON_ROUTE, PICKED_UP_BY_DRIVER, DELAYED, DELIVERY_FAILED, DELIVERED,
  AWAITING_CUSTOMER_PICKUP, COLLECTED_BY_CUSTOMER, ANNOUNCED_UNCOLLECTED, COLLECT_ERROR,
  UNDELIVERABLE, NO_LABEL, CANCELLING_UPSTREAM, CANCELLING, CANCELLED, CANCELLED_UPSTREAM,
  CANCELLATION_FAILED, UNKNOWN, ANNOUNCEMENT_FAILED, AT_CUSTOMS, REFUSED_BY_RECIPIENT,
  RETURNED_TO_SENDER, DELIVERY_METHOD_CHANGED, DELIVERY_DATE_CHANGED,
  DELIVERY_ADDRESS_CHANGED, EXCEPTION, ADDRESS_INVALID.
  Mapping: READY_TO_SEND/ANNOUNCED/ANNOUNCING/NO_LABEL → LABEL_CREATED;
  TO_SORTING/SORTING/SORTED/UNSORTED/AT_SORTING_CENTRE/SHIPMENT_ON_ROUTE/DRIVER_ON_ROUTE/
  PICKED_UP_BY_DRIVER/DELAYED/AT_CUSTOMS/DELIVERY_*_CHANGED → IN_TRANSIT (first one =
  "first scan" → SHIPPED); AWAITING_CUSTOMER_PICKUP → AWAITING_PICKUP; DELIVERED/
  COLLECTED_BY_CUSTOMER → DELIVERED; RETURNED_TO_SENDER/REFUSED_BY_RECIPIENT → RETURNED;
  CANCELLING*/CANCELLED*/ANNOUNCED_UNCOLLECTED → CANCELLED; ANNOUNCEMENT_FAILED → FAILED;
  DELIVERY_FAILED/COLLECT_ERROR/UNDELIVERABLE/EXCEPTION/ADDRESS_INVALID/
  CANCELLATION_FAILED → EXCEPTION; UNKNOWN or anything new → unchanged + logged (never
  DELIVERED).
- Fixtures (secrets never included; label bytes truncated) live in
  `apps/api/src/modules/fulfilment/__fixtures__/`.
- **Webhook signature key:** if the panel has no dedicated Webhook Signature Key, Sendcloud
  signs with the integration **secret key** — so `SENDCLOUD_WEBHOOK_SECRET` is optional and
  falls back to `SENDCLOUD_SECRET_KEY`.

## 12. Decisions (client, 2026-09-24)

**Taken:** D1 keys supplied (plan/carriers per §11a) · D2 **keep today's prices** · D3
**labels only when staff click** (single or bulk) · D4 **first scan** · D5 **phone and house
number required** · D6 **yes, email "ready for pickup"** · D7 delegated → **A6 PDF**
(Sendcloud's native size, what thermal label printers take; the print endpoint can add an
A4 4-up layout later) · D8 **shipping zones and rates fully editable in the dashboard** (was
seed-only; now in scope, §7a) · D9 → `labels/` prefix in the private bucket.
**D2b resolved 2026-09-25:** DHL removed from every zone (soft-deleted); "Envío en punto de
recogida UPS" at €19.99 (`ups:standard/service_point`) replaces it in Spain, EU and
Ireland; InPost €8.99 stays in Spain and EU. Applied by `seed-shipping-ups-2026-09-25.ts`.

Original questions, kept for the record:

| Id | Question | Recommendation |
|---|---|---|
| D1 | Is there a Sendcloud account yet, on which plan, with which carriers active (Sendcloud rates or own contracts)? Is the sender (warehouse) address set up in it? | Needed before any build beyond Phase 1; Growth if G2 requires it. |
| D2 | Which methods per zone and at what customer price? Today: DHL pickup €19.99 and InPost pickup €8.99 in ES and EU. The reference shows "DPD Point relais €19.95". Home delivery too? | Keep our prices; decide the carrier list after G1. |
| D3 | Labels: created automatically when an order is paid, or only when staff click "Generar etiquetas" (single/bulk)? | **Manual bulk** — a label is billed on creation, and paid orders are sometimes refunded or corrected before shipping. Auto can be a later switch. |
| D4 | When is an order "Enviado" (and the shipping email sent): at label creation, or at the carrier's first scan? | First scan (§3.7) — it is true when the customer reads it. |
| D5 | Make phone and house number required at checkout? | Yes (S17). |
| D6 | Send a "ya está en tu punto de recogida" email? | Yes, it is the moment the customer must act. |
| D7 | Label paper: A6 thermal label printer or A4 office printer? | A6 PDF unless they have no label printer. |
| D8 | Should staff edit shipping prices/methods from the dashboard now, or keep seed-managed rates? | Seed-managed in v1. |
| D9 | Separate bucket for labels or a prefix in the existing private bucket? | Prefix `labels/` in the private bucket — one less piece of infra. |

## 13. Non-goals (v1)

Returns labels, multicollo, customs documents (all served countries are EU), Sendcloud
Orders API / panel review flow, live Sendcloud-priced checkout, hosted map picker.
