# Wompi integration — binding contract

Status: **binding**. Where this document and the code disagree, this document wins
and the code is the defect; a deliberate deviation amends this file in the same
commit. Replaces the Whop contract (deleted).

Wompi references: [Web Checkout](https://docs.wompi.co/docs/colombia/widget-checkout-web/),
[Eventos](https://docs.wompi.co/docs/colombia/eventos/),
[Ambientes y llaves](https://docs.wompi.co/docs/colombia/ambientes-y-llaves/).

## 1. Shape

Akai uses **Wompi Web Checkout** (hosted redirect). The API builds and signs the
checkout URL; the shopper pays on `checkout.wompi.co`; Wompi returns the browser to
our processing page and sends a `transaction.updated` event to our webhook.

Out of scope, by design: card tokenisation, payment sources, PSE bank lists,
payouts, wallets, any Wompi API call to *create* a payment.

Code: `apps/api/src/modules/payments` — `wompi/wompi-checkout.ts` (URL + integrity
signature, pure), `wompi/wompi-events.ts` (event schemas + checksum, pure),
`wompi/live-wompi.gateway.ts` (the one outbound call), `wompi-settlement.service.ts`
(the one settlement path), `webhook/wompi-webhook.controller.ts`,
`payments.service.ts` (checkout, return-page confirm, sweep).

## 2. Amount authority

1. **Our API is the source of truth.** `amount-in-cents` is the order's stored
   `grandTotal` — integer centavos, the same unit as Wompi's `amount_in_cents`
   (`$ 89.000` = `8900000`). No conversion anywhere on the payment path.
2. `startCheckout` re-derives the total from the order lines (lines gross + shipping
   net + shipping tax) and **refuses** (`CHECKOUT_TOTAL_MISMATCH`) if it disagrees
   with `grandTotal`. No request schema carries an amount to charge.
3. Currency is `COP`; any other order currency is refused (`UNSUPPORTED_CURRENCY`).
4. **An order becomes PAID only** when an *authentic* Wompi transaction is
   `APPROVED` **and** `amount_in_cents === order.grandTotal` **and**
   `currency === order.currency`. Absent, fractional or out-of-range amount →
   `AMOUNT_ABSENT`; different amount → `AMOUNT_DIFFERS`; different currency →
   `CURRENCY_DIFFERS`. Any of these → `PAYMENT_MISMATCH` + an operator alert
   (`notifications` / `payment-mismatch`), stock held (neither sold nor released),
   nothing invoiced or emailed. Never PAID.
5. "Authentic" means one of: an event whose checksum verified (§5), or a transaction
   the API read itself from `GET /v1/transactions/{id}` with the **private** key (§7).
   Nothing a browser *says* is ever settled.

## 3. Checkout URL

`GET https://checkout.wompi.co/p/?…` (both environments), form-encoded:

| Parameter | Value |
| --- | --- |
| `public-key` | `WOMPI_PUBLIC_KEY` |
| `currency` | `COP` |
| `amount-in-cents` | `order.grandTotal` |
| `reference` | §4 |
| `signature:integrity` | §3.1 |
| `redirect-url` | `storefrontUrl(STOREFRONT_URL, "/checkout/processing", {order})` (the storefront is Spanish only; no locale segment) |
| `expiration-time` | now + **25 min**, ISO-8601 UTC (`Date#toISOString`) |
| `tax-in-cents:vat` | `order.taxTotal` (IVA contained in the IVA-inclusive total), omitted when 0 |
| `customer-data:email` / `full-name` | order email / billing name |
| `customer-data:phone-number` / `-prefix` | 10-digit mobile / `+57` (omitted without a phone) |
| `customer-data:legal-id` / `-type` | `order.documentNumber` / mapped `documentType` (§3.2) |
| `shipping-address:*` | the order's shipping snapshot (line 1/2, city, region = departamento, country, phone, name, postal code) |

The 25-minute expiry is deliberately **shorter than the 30-minute stock reservation**
(`RESERVATION_TTL_SECONDS`), so a link cannot be paid after its stock was handed back.

### 3.1 Integrity signature

```
signature:integrity = sha256hex(reference + amountInCents + currency + expirationTime + WOMPI_INTEGRITY_SECRET)
```

(`expirationTime` omitted from the concatenation when a checkout has none.) Plain
SHA-256 over the concatenation — not an HMAC. Verified in unit tests against
Wompi's documented vector.

### 3.2 Legal-id types

Wompi documents `CC, CE, NIT, PP, TI, DNI, RG, OTHER`. Mapping: CC, CE, NIT, PP, TI →
same; **PPT → OTHER** (no Wompi code; conservative). WOMPI-VERIFY with a sandbox PSE
payment.

## 4. Reference scheme

`reference = <orderNumber>-<attempt>`, e.g. `AK-2026-000123-1`.

- `attempt` = 1 + the order's payment rows that carry a reference, counted **under
  the order row lock** (`SELECT … FOR UPDATE`) in `startCheckout`, so it is unique per
  attempt and never reused — a retried checkout or a staff re-issue mints `-2`, `-3`.
- Persisted on the attempt row (`payment.providerReference`,
  status `REQUIRES_PAYMENT_METHOD`) **before** the redirect, in the same transaction
  that moves the order to `AWAITING_PAYMENT`. An event can never arrive for a
  reference we have not stored.
- Correlation: `findOrderByPaymentReference` → `payment.providerReference` → order,
  **locking the order row**. Not `@unique`: Web Checkout may produce several
  transactions under one reference (a decline, then a retry).
- Transaction → ledger (`recordTransaction`, keyed on the Wompi transaction id,
  `payment.providerPaymentId @unique`): update the row that already has this id; else
  CLAIM the attempt row for this reference that has none; else insert a new row
  (only with a valid reported amount — never an invented one).

## 5. Webhook — `POST /v1/webhooks/wompi`

Configured in the Wompi dashboard as the **URL de Eventos**, separately for sandbox
and production. In order:

0. No `WOMPI_*` keys configured → **503** (Wompi retries; we never verify against an
   empty secret, which anyone could compute).
1. Envelope (`event`, `data`, `signature{properties, checksum}`, `timestamp`) parsed
   with zod after stripping `__proto__`/`constructor`/`prototype` → otherwise **400**.
2. **Checksum** (ours, not a vendor library):
   `sha256hex(values of signature.properties resolved against data, concatenated in
   order + timestamp + WOMPI_EVENTS_SECRET)`, plain SHA-256, constant-time compare,
   case-insensitive hex. If `X-Event-Checksum` is present it must equal the body's
   checksum. Mismatch → **400** `INVALID_SIGNATURE`, logged with prefixes/lengths
   only (never the secret or a full digest).
3. `environment` present and ≠ our environment (`test`/`prod`) → 200 `ignored`.
   `event` ≠ `transaction.updated` → 200 `ignored`.
4. `data.transaction` parsed with zod (`.strip()` — vendor-owned shape; unknown keys
   dropped, never trusted). Fails → 200 `unparsable` + ONE alert, deduped on
   `unparsable:<checksum>`.
5. Settle (§6). **Always 200 from step 3 on** — ignored, duplicate, unmatched,
   unparsable included — or Wompi retries (30 min, 3 h, 24 h).

No raw body: the checksum covers parsed fields, not bytes. (The raw-body middleware
remains, mounted on the Resend webhook only.)

## 6. Statuses → order transitions

One code path, `WompiSettlementService.applyTransaction`, for every source (webhook,
return page, sweep).

| Wompi status | Order | Ledger | Side effects |
| --- | --- | --- | --- |
| `APPROVED`, amount+currency match, order PENDING/AWAITING_PAYMENT | → **PAID** (invoice number allocated in the same transaction) | SUCCEEDED | stock SOLD, order-confirmation + payment-receipt + admin-new-order emails |
| `APPROVED`, mismatch | → **PAYMENT_MISMATCH** | SUCCEEDED with Wompi's figure | alert; stock held |
| `APPROVED`, order already settled (another transaction) | unchanged | SUCCEEDED | alert `duplicate-payment` |
| `APPROVED`, order FAILED/CANCELLED | unchanged | SUCCEEDED | alert `payment-after-failure` |
| `DECLINED` / `VOIDED` / `ERROR` | → **FAILED** | FAILED (`failureCode` = status) | reservations released, `payment-failed` email |
| `PENDING` | unchanged | PROCESSING + transaction id (for the sweep) | none |
| unknown status | unchanged | none | logged, 200 |

- **PAYMENT_MISMATCH is an operator-only hold**: no automated path leaves it
  (`isOperatorHeld`), and every event for such an order is ACKed and ignored.
- A failure for an order already PAID or beyond is a no-op (ledger and status).
- Unknown reference (or, on the return page, a reference belonging to a different
  order) → `unmatched`, 200, and the dedupe row is rolled back.

## 7. Idempotency and reconciliation

- **Dedupe key** `wompi:<transactionId>:<status>` in `provider_event`, inserted in
  the SAME transaction as the state change. Shared by all three sources, so whichever
  sees a state first applies it and the others are `duplicate`.
- The order row lock in correlation serialises different keys for one order.
- **Return page**: Wompi appends `?id=<transactionId>` to `redirect-url`. The
  storefront validates the shape (`wompiTransactionIdSchema`) and calls
  `POST /v1/payments/orders/:number/confirm {transactionId}` once (throttled
  10/min), then polls `GET /v1/payments/orders/:number/status`. The API fetches
  `GET /v1/transactions/{id}` with the private key and settles only if the
  transaction's reference belongs to that order. It never fails the page: unknown
  id, wrong order or Wompi down → the current status.
- **Sweep** (`payment-reconciliation`, every 5 min, `ScheduledJobsRunner`): payments
  in PROCESSING with a transaction id, on orders still AWAITING_PAYMENT, untouched
  for 10 min → fetched from Wompi and settled the same way (batch of 20).

## 8. Refunds are manual

Wompi's public API has **no refund endpoint for Web Checkout payments**. Staff refund
in the Wompi dashboard, then record it: `POST /v1/admin/orders/:orderNumber/refunds`
(`OrdersService.recordRefund`, the one refund implementation) with `amount?`,
`reason`, `note?`, `providerRefundId?` (the Wompi reference). In one transaction: a
SUCCEEDED refund row, `refundedTotal`, PARTIALLY_REFUNDED / REFUNDED (derived,
optimistic-concurrency write), a timeline entry and the `refund-confirmation` email.
Allowed from PAID…DELIVERED, PARTIALLY_REFUNDED and PAYMENT_MISMATCH; capped by
`grandTotal − refundedTotal − pending` AND by what the settled payment captured; a
Wompi reference can be recorded once.

## 9. Environments and keys

| Variable | sandbox | live |
| --- | --- | --- |
| `WOMPI_ENVIRONMENT` | `sandbox` (the default when unset) | `live` — **must be pinned**; production refuses unset or `sandbox` |
| `WOMPI_PUBLIC_KEY` | `pub_test_…` | `pub_prod_…` |
| `WOMPI_PRIVATE_KEY` | `prv_test_…` | `prv_prod_…` |
| `WOMPI_INTEGRITY_SECRET` | `test_integrity_…` | `prod_integrity_…` |
| `WOMPI_EVENTS_SECRET` | `test_events_…` | `prod_events_…` |
| API base (derived) | `https://sandbox.wompi.co/v1` | `https://production.wompi.co/v1` |

- The environment is never inferred from `NODE_ENV` (the deployed API may run
  `NODE_ENV=development`). There is no `WOMPI_BASE_URL`.
- `libs/config` refuses a key whose prefix belongs to the other environment, and
  requires all four keys while `PAYMENTS_ENABLED=true`. Consumers read
  `config.wompi` (null when keys are absent, which only `PAYMENTS_ENABLED=false`
  allows). Secrets are redacted from logs.
- `PAYMENTS_ENABLED=false` settles orders locally (same settlement steps, no payment
  row); production refuses it.

## 10. To verify against a real sandbox (WOMPI-VERIFY)

1. The event checksum with real deliveries (property paths, null handling, hex case).
2. That `environment` is `test` / `prod` on real events.
3. PPT → `OTHER` and NIT with check digit (`900123456-7`) accepted as `legal-id`.
4. `tax-in-cents:vat` accepted as the IVA contained in the total.
5. Whether Web Checkout reuses a reference after a decline (drives `payment-after-failure`).
6. Transaction id shape on the return URL (validated permissively as `[A-Za-z0-9-]{1,64}`).
