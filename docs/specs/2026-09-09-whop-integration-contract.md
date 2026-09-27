# Whop integration contract

**Status:** design lock, 2026-09-09. **Binding.**
**Supersedes:** `2026-07-21-tagadapay-integration-contract.md`, now marked SUPERSEDED. That
document remains in the tree as the record of *why* several decisions here look the way
they do — most of this contract is the inverse of one of its constraints.

**This document is the single source of truth for the payments plane.** Every signature,
column name, schema, env var, string constant and file path below is **verbatim**. If the
implementation disagrees with this file, this file wins and the code is the defect. Where
the code must deviate, this file is amended in the same commit.

SDK under contract: **`@whop/sdk@1.1.2`**, pinned exactly (not `^`) at the workspace root.
Base URL `https://api.whop.com/api/v1`.

---

## 0. Evidence ledger

Every claim is cited to a shipped file in `@whop/sdk@1.1.2` or to `docs.whop.com`. Paths
are relative to `node_modules/@whop/sdk/dist/cjs/`.

| # | Fact | Evidence |
| --- | --- | --- |
| W1 | `checkoutConfigurations.create` accepts an **inline `plan`** carrying `initial_price`, `currency`, `plan_type`, `title`, `metadata`, `visibility`, `product_id`, `override_tax_type`, `force_create_new_plan`. **An amount CAN be passed in.** | `api/resources/checkoutConfigurations/client/requests/CreateCheckoutConfigurationsRequest.d.ts`, `Plan` namespace |
| W2 | The same call takes top-level `metadata` and `redirect_url`. Docs: *"Payments and memberships created from a checkout session inherit its metadata."* | same file; `docs.whop.com/api-reference/checkout-configurations/checkout-configuration` |
| W3 | `CreateCheckoutConfigurationsResponse.purchase_url` is `string \| null \| undefined`. | `api/resources/checkoutConfigurations/types/CreateCheckoutConfigurationsResponse.d.ts` |
| W4 | Request fields are all optional but there is **no index signature**. A typo is a compile error. | `CreateCheckoutConfigurationsRequest.d.ts` |
| W5 | Webhooks are **Standard Webhooks**: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`; signed material is `{webhook-id}.{webhook-timestamp}.{raw body}`; 5-minute tolerance. | `docs.whop.com/developer/guides/webhooks`; `standardwebhooks@^1.0.0` is a hard dependency |
| W6 | `unwrapWebhook` **is publicly exported** from `@whop/sdk/helpers`, verifies via `standardwebhooks`, and base64-encodes the `ws_` secret to cancel that library's strict base64 decode. Handing it a raw `ws_` secret throws `Base64Coder: incorrect characters for decoding` — a constructor throw, not a clean `false`. | `package.json` `exports["./helpers"]`; `helpers/verifyWebhook.js` |
| W7 | `unwrapWebhook<TEvent = Record<string, unknown>>` — `TEvent` is an **unchecked assertion**, stated in its own doc comment: *"nothing here checks the payload against it"*. | `helpers/verifyWebhook.d.ts` |
| W8 | REST money is `Whop.Money = { amount: string /* exact decimal, MAJOR units */, currency, decimals, display_decimals }` — *"A string so no float rounds it in transit."* | `api/types/Money.d.ts` |
| W9 | Webhook money is **not** `Money`. `PostPaymentSucceededPayload.data` is `Whop.PaymentLegacy`, whose `total`, `subtotal`, `refunded_amount`, `tax_amount` are bare `number` — major-unit floats. | `api/resources/payments/types/PostPaymentSucceededPayload.d.ts`; `api/types/PaymentLegacy.d.ts` |
| W10 | Request money is bare `number` in major units. | `CreatePlansRequest.d.ts`; `api/resources/payments/client/requests/RefundPaymentsRequest.d.ts` |
| W11 | `payments.refund({ id, partial_amount? })` returns a **typed `Promise<Payment>`**. `Refund` is a first-class model with `id`, `status`, `amount`. | `api/resources/payments/client/Client.d.ts`; `api/types/Refund.d.ts` |
| W12 | `idempotencyKey?: string` is first-class on `BaseRequestOptions`, per request. 24h retention; same key + different body → 400; in-flight reuse → 409. | `BaseClient.d.ts`; `docs.whop.com/developer/api/idempotency` |
| W13 | `apiVersionDate` is first-class on both client and request options, and pins the payload shape. | `BaseClient.d.ts`; `docs.whop.com/developer/api/versioning` |
| W14 | EUR is supported, **lowercase** (`Currency.Eur: "eur"`). | `api/types/CheckoutConfiguration.d.ts` |
| W15 | Payment lifecycle is `ReceiptStatus` (`draft \| open \| authorized \| paid \| pending \| uncollectible \| unresolved \| void`) plus a 29-value `FriendlyReceiptStatus` substatus. | `api/types/ReceiptStatus.d.ts`; `api/types/FriendlyReceiptStatus.d.ts` |
| W16 | The envelope carries a vendor `id` (`msg_…`); the transport carries `webhook-id`. Docs: *"Store `webhook-id` to identify and ignore duplicate deliveries."* Retries: 12 attempts over ~71h. **Ordering is not guaranteed.** | `PostPaymentSucceededPayload.d.ts`; `docs.whop.com/developer/guides/webhooks` |
| W17 | Webhook endpoints are registered **in the Whop dashboard** (Developer → Webhooks), not via API bootstrap. | `docs.whop.com/developer/quickstart` |
| W18 | `Plan.collect_tax: boolean` and `Plan.tax_type` exist on the **response** but are not settable on create; only `override_tax_type` is. | `api/types/Plan.d.ts` vs `CreatePlansRequest.d.ts` |

### 0.1 The three consequences that reshape everything

1. **W1 kills the catalog mirror.** The Tagada contract's §0 E3 — *"there is no amount,
   price or total field anywhere on `CheckoutInitParams`"* — is what made
   `providerVariantId` load-bearing, made sync failure an outage, and forced
   `VariantNotMirroredError` and `DiscountsUnsupportedError`. Whop takes our number. The
   mirror, both of those errors, `ProductSyncService` and `catalog-sync.outbox-handler` are
   **deleted**.
2. **W6 kills our hand-rolled HMAC.** The Tagada contract implemented verification in-repo
   because the SDK's honest verifier was unexported (its E5). Whop's is exported and
   correct, and handles a secret-encoding subtlety we would get wrong. **W7 survives**, so
   the split is: verification theirs, parsing ours.
3. **W8/W9/W10 mean Whop speaks major units.** Rule 3 (integer minor units end-to-end) is
   unchanged *inside* the system. One converter pair in `libs/money` owns the boundary.

---

## 1. `libs/money` — the currency boundary

`toDecimalString(amount: Minor, currency: CurrencyCode): string` already exists and is the
outbound primitive. Its inverse is added in the same file:

```ts
export function fromDecimalString(value: string, currency: CurrencyCode): Minor;
```

**Integer and string operations only.** `Number(value) * 100` would reintroduce exactly the
binary-float rounding integer minor units exist to prevent.

It **rejects, never coerces**: exponent notation, more fraction digits than the currency's
exponent, leading `+`, whitespace, empty string, `NaN`/`Infinity` spellings, anything
non-numeric, and any result outside `Number.MAX_SAFE_INTEGER`. A malformed amount must
reach `PAYMENT_MISMATCH`, not a rounded number.

**Three call sites, and only three:**

| Direction | Source | Call |
| --- | --- | --- |
| Outbound (`initial_price`, `partial_amount`; bare `number`, W10) | our `Minor` | `Number(toDecimalString(minor, currency))` |
| Inbound REST (`Money.amount`; exact string, W8) | Whop | `fromDecimalString(money.amount, currency)` |
| Inbound webhook (`PaymentLegacy.total`; float, W9) | Whop | `fromDecimalString(String(n), currency)` |

The outbound direction is safe because the double nearest `49.99` serialises back to
exactly `"49.99"` — JS emits the shortest round-tripping decimal. The webhook direction is
safe for the same reason, in reverse: `String(n)` is that shortest form, so no precision
is invented. Both are covered by a round-trip test over the full minor range.

---

## 2. The `WhopGateway` port

**Path:** `apps/api/src/modules/payments/whop/whop.gateway.ts`

Retains the Tagada port's two rationales — testability without casts, and one file that
answers *"what can this system do to Whop"*. **Three methods, and only three.** There is no
product, plan, or webhook-registration method: §0.1(1) deletes the mirror and W17 makes
registration a dashboard action.

```ts
export interface WhopGateway {
  createCheckoutConfiguration(
    params: WhopCheckoutParams,
    options: WhopRequestOptions,
  ): Promise<WhopCheckoutResult>;

  retrievePayment(paymentId: string): Promise<Payment>;

  refundPayment(
    params: WhopRefundParams,
    options: WhopRequestOptions,
  ): Promise<Payment>;
}

export const WHOP_GATEWAY = Symbol("WHOP_GATEWAY");
```

**`WhopCheckoutParams` is narrow — required where the SDK is optional.** The Tagada port's
`_ParamsAreAssignable` compile-time proof is **deliberately not carried over**: it existed
to defend against `CheckoutInitParams`'s `[key: string]: unknown` index signature, and W4
says Whop has none, so tsc already rejects a typo. Keeping a proof for a hazard that no
longer exists is cargo.

```ts
export interface WhopCheckoutParams {
  readonly accountId: string;
  readonly productId: string;
  /** Our recomputed grand total, in MAJOR units. See §1. */
  readonly initialPrice: number;
  /** ISO-4217, LOWERCASE — Whop's enum is lowercase (W14). */
  readonly currency: string;
  /** Shown on the hosted page. The order number. */
  readonly title: string;
  /** Correlation. Inherited by the payment (W2). */
  readonly metadata: { readonly order_id: string; readonly order_number: string };
  /** The processing screen. Never a success page. */
  readonly redirectUrl: string;
}
```

**`override_tax_type: "inclusive"` is set by the adapter, not by the caller**, and is not a
parameter. Our `grandTotal` already contains EU VAT computed by the `tax` module; Whop must
not add more on top. It is a property of this integration, not of an individual checkout,
so it belongs in the one place that constructs the request. See §7 S1.

### 2.1 `LiveWhopGateway`

**Path:** `apps/api/src/modules/payments/whop/live-whop.gateway.ts`

- `@Injectable()`, constructor-injects `SERVER_CONFIG` and `LOGGER`.
- Constructs exactly one client:
  `new WhopClient({ apiKey, baseUrl, apiVersionDate })` — **`apiVersionDate` is always
  passed** (W13). Unpinned, Whop may change `PaymentLegacy` under us.
- `implements OnModuleInit`. `onModuleInit` asserts credentials with `accounts.me()` and
  rethrows as `WhopBootCheckFailedError`. A misconfigured key must kill the boot, not the
  first checkout. Skipped when `WHOP_BOOT_CHECK=false`.
- Injected config is narrowed to
  `WhopGatewayConfig = Pick<ServerEnv, "WHOP_API_KEY" | "WHOP_BASE_URL" | "WHOP_ACCOUNT_ID" | "WHOP_PRODUCT_ID" | "WHOP_API_VERSION_DATE" | "WHOP_BOOT_CHECK">`.
  `SERVER_CONFIG` supplies a full `ServerEnv` and satisfies it structurally.
- Every method wraps SDK failures: catch, narrow, log, rethrow as
  `PaymentProviderUnavailableError` (transport, retryable) or
  `PaymentProviderRequestError` (rejected, not retryable). The two-way split is unchanged
  from the Tagada port and for the same reason: a caller has exactly two decisions.

### 2.2 `FakeWhopGateway`

**Path:** `apps/api/src/modules/payments/testing/fake-whop.gateway.ts`

`implements WhopGateway`, zero casts, zero `any`. Records every call as
`RecordedGatewayCall<TParams> = { params, options }`. Exposes a settable
`nextPurchaseUrl: string | null` so the null path (W3) is directly testable. Default
`"https://whop.com/checkout/ch_test_000000/"`.

---

## 3. Checkout

`checkout.service.ts` and `CheckoutPaymentsPort = Pick<PaymentsService, "startCheckout">`
are **untouched**. Do not couple either to Whop.

### 3.1 `PaymentsService.startCheckout(orderId)` — required sequence

1. Load order; `OrderNotFoundError` / `OrderNotPayableError` as today.
2. `PAYMENTS_ENABLED=false` → `settleWithoutProvider(order)`, unchanged.
3. Load lines. **The local-total invariant survives and REGAINS ITS STRONG MEANING**:
   `chargedTotal(order, lines) !== order.grandTotal → CheckoutTotalMismatchError`. Under
   Tagada this could only prove internal consistency, because Tagada priced from its own
   catalog. Under Whop we set the price, so this again predicts exactly what will be
   charged.

   **The identity is the GROSS one, and it is the same one `assertTotalsBalance` enforces
   when the order is written** (`orders/order-totals.ts`):

   ```
   chargedTotal = Σ line.lineTotalGross + (order.shippingTotal + shippingTax)
   shippingTax  = order.taxTotal − Σ line.taxAmount
   ```

   Three facts about the stored row force this shape, and getting any of them wrong
   mispriced the order:
   - **Lines are stored GROSS and net of their own discount.** So `lineTotalGross` is
     summed directly: neither the line's tax nor `order.discountTotal` is applied again.
   - **Shipping alone is stored NET** (`shippingTotal: shipping.net`), while `grandTotal`
     contains it gross.
   - **`taxTotal` bundles line tax with shipping tax**, so the shipping tax is the remainder
     after the lines claim their share — which is why `OrderLineSnapshot` carries
     `taxAmount` (deviation D-07).

   **D-07 — the guard was wrong from `ca69dda` (2026-07-20) and this contract's own
   §3.1(3) did not catch it.** The original summed `unitPriceGross × quantity` against NET
   shipping and ignored `taxTotal` entirely, dropping the shipping VAT, then subtracted
   `order.discountTotal` a second time. It never fired because it runs only under
   `PAYMENTS_ENABLED=true` and the demo path returns at step 2 — so **the first genuinely
   enabled checkout would have returned 500 on every order with taxed shipping.** Caught on
   the first sandbox order (AK-2026-000003: computed 2234, stored 2285, the 51 being the VAT
   on 2.95 shipping). Regression test: *"counts the tax on SHIPPING, which is stored net
   while the total is gross"*.
4. **No sync gate and no discount guard.** Both deleted — see §0.1(1).
5. Call `createCheckoutConfiguration` with
   `initialPrice: Number(toDecimalString(order.grandTotal, order.currency))`,
   `currency: order.currency.toLowerCase()` (W14),
   `metadata: { order_id: order.id, order_number: order.orderNumber }`,
   `redirectUrl: storefrontUrl(STOREFRONT_URL, order.locale, "/checkout/processing", { order: orderNumber })`,
   and `idempotencyKey: this.idempotencyKey("checkout", order.id, order.grandTotal)` —
   derivation and rationale unchanged.
6. **`purchaseUrl === null` → `CheckoutUrlMissingError(orderNumber)`.** Same rationale as
   the Tagada `CheckoutTokenMissingError` it replaces: never send a customer to a payment
   page we cannot correlate a webhook back to.
7. In one transaction: `linkCheckoutId(order.id, checkoutId)`, `recordPaymentAttempt({ …,
   providerPaymentId: null })`, transition to `AWAITING_PAYMENT` guarded by
   `isRedundantTransition`, `appendOrderEvent`.
8. Return `{ orderNumber, checkoutUrl: purchaseUrl }`.

**Discounts now work.** An order with `discountTotal > 0` is simply a smaller
`initial_price`. This is a capability the Tagada path could not have.

---

## 4. Order correlation

Two keys, both reliable. The Tagada three-rank chain, the `providerOrderId` column and the
`linkProviderOrder` backfill rule are **deleted**: they existed to survive a payload that
might carry none of our keys, which W2 rules out.

| Rank | Key on the payload | Column matched | Why |
| --- | --- | --- | --- |
| 1 | `data.metadata.order_id` | `Order.id` | Our own UUID, set on the checkout configuration, inherited by the payment (W2). Independent of anything Whop mints. |
| 2 | `data.checkout_configuration_id` | `Order.providerCheckoutId` | Persisted before the customer reaches the payment page, so it cannot lose a race with the webhook. |

`Order.providerCheckoutToken` is renamed `providerCheckoutId` — it holds a `ch_…`.

**Unmatched events** keep today's behaviour: log at `warn`, ACK `200`,
`{ status: "unmatched" }`. A non-2xx would cost a 71-hour retry storm and eventual endpoint
disablement (W16).

**Ordering is not guaranteed** (W16). This is already handled by `isRedundantTransition`
plus the `FOR UPDATE` row lock, and is covered by an explicit test rather than assumed.

---

## 5. Webhook verification

**Endpoint:** `POST /v1/webhooks/whop`. `@Public()` — it authenticates by signature, not by
session, which makes the signature check the entire security boundary.

**The path-scoped raw-body middleware stays.** `main.ts` mounts
`createRawBodyMiddleware()` on `WHOP_WEBHOOK_PATH` only, derived from `WHOP_WEBHOOK_ROUTE`
in `common/api-paths.ts`. Standard Webhooks signs raw bytes, so the requirement is
identical to Tagada's; only the constant is renamed. The global `rawBody: true` flag stays
off, for the blast-radius reason recorded in the superseded contract §4.0.

### 5.1 The sequence — six steps, down from nine

| # | Step | Failure |
| --- | --- | --- |
| 1 | `request.rawBody` is a `Buffer` | `400 RAW_BODY_UNAVAILABLE` + `logger.error` naming the middleware. Deliberately distinguished from a signature error: a generic message sends the next person debugging in the wrong direction. |
| 2 | `unwrapWebhook(raw, { headers, key })` — signature **and** timestamp window | `400 INVALID_SIGNATURE`, reason logged at `warn`, response generic |
| 3 | `whopEventEnvelopeSchema.safeParse` | `200`, `{ status: "unparsable" }`, `logger.error` + one deduped alert |
| 4 | Dedupe on `webhook-id` **inside the same transaction as the state change** | duplicate → `200`, `{ status: "duplicate" }` |
| 5 | Correlate | no match → `200`, `{ status: "unmatched" }`, transaction rolled back |
| 6 | Act | — |

**Three Tagada steps are gone**, all absorbed by step 2: the `sha256=` prefix check, the
hand-rolled `timingSafeEqual` HMAC, and the conditional body-timestamp replay window.

**The §4.3 replay hole is closed outright.** The superseded contract had to state plainly
that a signed, timestamp-less delivery bypassed the replay window unconditionally and that
`provider_event` was the sole defence. Whop binds `webhook-timestamp` into the signed
material with a 5-minute tolerance (W5), which is the property that document wanted and
could not obtain. `provider_event` remains as defence in depth, not as the only line.

### 5.2 Verification is the vendor's; parsing is ours

**Path:** `apps/api/src/modules/payments/webhook/whop-webhook.verify.ts`

```ts
export type WhopVerifyResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export function verifyWhopWebhook(
  rawBody: Buffer,
  headers: Record<string, string>,
  secret: string,
): WhopVerifyResult;
```

**`unwrapWebhook` is called with NO type argument.** It defaults to
`Record<string, unknown>` (W7). Naming a type there would be an unchecked assertion that
compiles clean — the exact rule-2 hazard the Tagada contract refused `constructEvent` for.
The difference is that Whop's verification half is sound, so we keep it and reject only the
typing half.

`WebhookVerificationError` is caught and mapped to `{ ok: false }`. It is thrown for a
missing or malformed header, a timestamp outside tolerance, and a signature mismatch alike
— we do not distinguish, because an attacker probing signatures must learn nothing.

**`FORBIDDEN_ENVELOPE_KEYS` / prototype-pollution filtering is retained** in the schema
module, applied to `data` and `data.metadata`. `unwrapWebhook` ends in `JSON.parse`, which
still creates `__proto__` as an own data property, and the original hole was real and
measured. The envelope-*flattening* machinery it guarded is gone (§5.3); the filter is not.

### 5.3 What the envelope simplification deletes

Whop's envelope is one documented shape with generated types per event:

```
{ id, type, api_version, api_version_date, timestamp, account_id, data, previous_attributes? }
```

Tagada shipped no CRM event type at all, so the superseded contract had to merge three
candidate layouts and then defend that merge. All of it goes:

- `flattenTagadaEnvelope`, `envelopeLayers`, `envelopeLayerConflicts`,
  `SETTLEMENT_CRITICAL_KEYS`, `recordConflicted`, `CONFLICTED_EVENT_TYPE`, the
  `conflicted` outcome, and the controller's `settlementCriticalConflicts`. There are no
  layers to disagree, so there is no conflict to detect.
- `provider-event-id.ts` in its entirety, the `derived:` fallback key, and the
  `ProviderEvent.derived` column. Whop assigns `webhook-id` (W16); the content fingerprint
  existed only because Tagada might assign nothing.
- `warnIfReplayWindowUnenforceable` and `whichEventsCarryNoTimestamp`. The window is
  always enforceable.

**`logUnknownEnvelopeKeys` is retained**, warning once per process per undeclared key on
`data`. The envelope stays `.strip()`, not `.strict()`, for the reason the superseded
contract argued and which still holds: Whop ships additive fields under a pinned version,
and `.strict()` would turn the first one into a total settlement outage. Every nested
object schema stays `.strict()`.

### 5.4 Handled event types

```ts
export const HANDLED_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "refund.created",
  "refund.updated",
] as const;
```

Dot-format, not Tagada's slash-format. `payment.authorized`, `payment.created`,
`payment.pending`, `payment.canceled` are ACKed and ignored — an order settles on
`succeeded` and nothing else. `dispute.*` is ACKed and logged, not acted on: the `disputes`
module is an empty placeholder and this contract does not change that.

---

## 6. Settlement

### 6.1 The predicate

`verifySettlement(event, order)` is unchanged in shape, meaning and criticality. It is
still the single most important predicate in the module, still pure, still exported for
testing without a container.

```
SETTLE ⟺ total !== null ∧ currency parses
       ∧ currency.toUpperCase() === order.currency
       ∧ fromDecimalString(String(total), order.currency) === order.grandTotal
```

**ABSENCE IS NEVER AGREEMENT.** An event that does not say what was charged cannot prove
the right amount was charged: `AMOUNT_ABSENT` → `PAYMENT_MISMATCH`. Unchanged.

**`total`, NEVER `amount_after_fees`.** `PaymentLegacy` carries both. `amount_after_fees`
is net of Whop's platform fee, so comparing it against `grandTotal` would mismatch **every
single order**. `total` is what the buyer was charged. This is the highest-consequence
field choice in the contract; see §7 S2.

`fromDecimalString` **throwing** is caught and treated as `AMOUNT_ABSENT` — a total we
cannot parse exactly is a total we cannot agree with.

### 6.2 Everything downstream is unchanged

`applyPaid`, `applyMismatch`, `applyFailed`, `reconcileRefund`, `isOperatorHeld`,
`recordSettlementPayment`, `settleOrderPaid`, and the `PAYMENT_MISMATCH` operator hold all
keep their current behaviour, comments and tests. In particular:

- **`applyMismatch` still does not release stock.** Money may have moved.
- **`applyFailed` still does release stock**, and still runs `isOperatorHeld` first.
- **`PAYMENT_MISMATCH` remains an operator-only hold.** No automated handler may leave it.
- **`upsertSettlementPayment` stays a single insert-or-update.** `payment.succeeded` no
  longer has an `order/paid` twin, so the concurrent-double-insert race that motivated it
  is less likely — but "less likely" is not "impossible" under redelivery, and the
  atomicity costs nothing.

`reconcileRefund` now reads `data.refunded_amount` (cumulative, float → `fromDecimalString`)
and keeps its converge-on-the-difference logic, which is what makes it idempotent and
commutative under out-of-order delivery (W16).

---

## 7. Refunds

`refundOrder`'s orchestration, ordering rationale, ceiling recomputation, in-transaction
re-read and ledger writes are **unchanged**. Three changes:

```ts
const refunded = await this.whop.refundPayment(
  {
    id: providerPaymentId,
    partialAmount: Number(toDecimalString(requested, order.currency)),
  },
  { idempotencyKey: this.idempotencyKey("refund", order.id, order.refundedTotal, requested) },
);
```

- **`tagada-refund.schema.ts` is deleted.** W11 returns a typed `Payment`, so the tolerant
  "the id might be in one of three places, or absent" schema has nothing left to defend
  against.

> **CORRECTION, recorded 2026-09-09 during implementation.** An earlier draft of this
> section said `providerRefundId` is read from `Payment.refunds` and that
> `RefundResponse.refundId` returns to non-null `string`. **`Whop.Payment` has no `refunds`
> array.** It exposes `refunded_amount: Money | null`, `refunded_at` and `refundable`, and
> nothing else refund-shaped (`api/types/Payment.d.ts`) — the array belongs to
> `PaymentLegacy`, the webhook shape. The refund id is therefore **not available
> synchronously** from the refund call.
>
> **Resolution: `RefundResponse.refundId` stays `string | null`, exactly as it is today, and
> `refundOrder` writes `providerRefundId: null`.** The two alternatives were both worse. A
> follow-up `refunds.list({ payment_id })` is a second network call inside the
> already-delicate window between the provider call and our transaction, and it races the
> refund row materialising. Returning our own `Refund` row id under a field named for the
> provider's would be a lie in a column an operator reconciles against Whop.
>
> Nothing is actually lost: the money moved and the refund is recorded either way, which is
> the property the Tagada schema's tolerance was protecting, and `refund.created` carries
> the `Refund` with its `id` for reconciliation. `libs/contracts` is therefore **unchanged**
> by this migration.
- **Refund reasons no longer travel.** `RefundPaymentsRequest` has `{ id, partial_amount }`
  and nothing else — no `metadata`, no `reason`. Our richer `RefundReason` vocabulary
  therefore stays authoritative in our own `Refund` row and Whop simply does not learn it.
  This is a **regression against the Tagada path**, which could carry it in
  `PaymentRefundParams.metadata`. Stated, not worked around: inventing a channel Whop does
  not have would mean writing the reason nowhere and believing it went somewhere.

---

## 8. Configuration

| Removed | Added |
| --- | --- |
| `TAGADA_API_KEY` | `WHOP_API_KEY` — `z.string().min(20)` |
| `TAGADA_WEBHOOK_SECRET` | `WHOP_WEBHOOK_SECRET` — `secret()`, **must start `ws_`** (W6: the prefix is part of the signing key; stripping it produces a wrong key, not an error) |
| `TAGADA_STORE_ID` | `WHOP_ACCOUNT_ID` — must start `biz_` |
| `TAGADA_CHECKOUT_URL` | *(gone — `purchase_url` comes back on the response)* |
| `TAGADA_BASE_URL` | *(gone — derived from `WHOP_ENVIRONMENT`, see §8.1)* |
| `TAGADA_BOOT_CHECK` | `WHOP_BOOT_CHECK` — same production refinement |
| — | `WHOP_PRODUCT_ID` — must start `prod_`; the single Whop product every per-order plan hangs off |
| — | `WHOP_API_VERSION_DATE` — `YYYY-MM-DD`, **required** (W13) |

`PAYMENTS_ENABLED`'s production refinement is unchanged. `.env.example` and
`libs/config/src/env-example.test.ts` move together — that test asserts the two agree.

### 8.1 AMENDMENT, 2026-09-10 — sandbox and live, selected at boot

Whop's sandbox is a **wholly separate account**, not a mode flag: its own dashboard
at `sandbox.whop.com`, its own `biz_`/`prod_` ids, its own keys and its own webhook
secret. Verified: the live key returns `200` from `api.whop.com/api/v1/accounts/me`
and `401` from `sandbox-api.whop.com`. There is no shared credential to reuse, which
is why this is a second credential SET rather than a boolean.

| Variable | Meaning |
| --- | --- |
| `WHOP_ENVIRONMENT` | `sandbox` \| `live`. Optional; defaults from `NODE_ENV` (development → sandbox, production → live). |
| `WHOP_*` (unprefixed) | The **LIVE** credential set. Unchanged. |
| `WHOP_SANDBOX_API_KEY` / `_ACCOUNT_ID` / `_PRODUCT_ID` / `_WEBHOOK_SECRET` | The sandbox set. Optional. |

**`WHOP_BASE_URL` IS DELETED AND DERIVED.** `live` →
`https://api.whop.com/api/v1`, `sandbox` → `https://sandbox-api.whop.com/api/v1`.
The two must never disagree — a live key against the sandbox host 401s and vice
versa — and two variables that have to agree is a way to point real credentials at
a fake processor by editing one of them.

**THE DEFAULT IS NOT THE RULE, AND ON THIS PLATFORM THAT IS LOAD-BEARING.** The
deployed API deliberately runs `NODE_ENV=development` (§9 of
`akai-dokploy-deployment`: the schema refuses `PAYMENTS_ENABLED=false` in
production, and this deployment ran credential-free). A pure `NODE_ENV` rule would
therefore resolve the LIVE deployment to sandbox, and the moment payments were
enabled real customers would be handed a sandbox payment page and their orders
marked `PAID` having taken no money — the same fraud the `PAYMENTS_ENABLED` guard
exists to prevent, arriving through another door. **The deployment pins
`WHOP_ENVIRONMENT=live` explicitly**, and the default governs only a developer's
laptop.

Two refinements enforce the rest:

- `NODE_ENV=production` with `WHOP_ENVIRONMENT=sandbox` is refused outright. An
  override may correct the default; it may never invert the one case where the
  answer is not a judgement call.
- The sandbox set is required only when sandbox is resolved **AND**
  `PAYMENTS_ENABLED=true`. With payments off, checkout settles in-process and never
  reaches Whop, so demanding four sandbox credentials would stop a fresh clone
  booting merely to look at the shop — the same reasoning as `WHOP_BOOT_CHECK`.

**RESOLVED ONCE, AT BOOT.** `libs/config` exposes `config.whop`
(`{ environment, apiKey, accountId, productId, webhookSecret, baseUrl }`) and every
consumer reads it. The gateway, the webhook controller and `startCheckout` do not
each decide which account they are talking to: a gateway on one environment while
the webhook verifies against the other is a payment taken in sandbox and settled
against production.

Sandbox test cards (any future expiry, any CVV): `4242 4242 4242 4242` succeeds,
`4000 0000 0000 0002` declines, `4000 0000 0000 0341` saves then later declines,
`5385 3083 6013 5181` triggers 3-D Secure (code `Checkout1!`).

---

## 9. Database

One migration, `whop_payments`:

```sql
ALTER TYPE "PaymentProvider" RENAME VALUE 'TAGADA' TO 'WHOP';
ALTER TABLE "order" RENAME COLUMN "provider_checkout_token" TO "provider_checkout_id";
ALTER TABLE "order" DROP COLUMN "provider_order_id";
ALTER TABLE "product" DROP COLUMN "provider_product_id";
ALTER TABLE "product_variant" DROP COLUMN "provider_variant_id";
ALTER TABLE "price_history" DROP COLUMN "provider_variant_id";
ALTER TABLE "provider_event" DROP COLUMN "derived";
```

**`RENAME VALUE`, not a drop-and-recreate.** It preserves every existing row whether or not
any exist, so the enum change carries no data-migration question and no environment-specific
branch.

`libs/contracts/src/lib/enums.ts`: `paymentProviderSchema = z.enum(["WHOP"])`.

---

## 10. Spike gates

Unknowns that only a sandbox account settles. Each states its failure direction.

- **S1 — tax behaviour.** We compute EU VAT into `grandTotal`; `Plan.collect_tax` is not
  settable on create (W18). This contract sets `override_tax_type: "inclusive"` on the
  inline plan, which is the correct declaration for a price that already contains tax, but
  it is **unverified against a live account**. *Failure direction: loud.* If Whop adds VAT
  on top anyway, the reported `total` exceeds `grandTotal`, `verifySettlement` returns
  `AMOUNT_DIFFERS`, and the order lands in `PAYMENT_MISMATCH` with an operator alert. No
  customer is silently overcharged and no order silently settles wrong. **Verify before
  production traffic.**
- **S2 — `total` vs `amount_after_fees`.** §6.1 asserts `total` is the buyer-charged
  amount. If it is in fact net of fees, *every* order mismatches on the first live
  transaction — loud, immediate, unmissable, and no money is misapplied. Confirm with one
  dashboard test event (W17) before go-live.
- **S3 — metadata round-trip.** Confirm `checkout_configuration.metadata` really surfaces
  as `payment.metadata` on a live `payment.succeeded`. *Failure direction: safe* — rank 2
  (`checkout_configuration_id`) still correlates and rank 1 becomes dead weight.
- **S4 — `purchase_url` nullability.** Typed nullable (W3). Handled either way by
  `CheckoutUrlMissingError`; observe whether it ever actually is null.
- **S5 — customer email prefill.** No email field on the create request. Determine whether
  `purchase_url` accepts an `?email=` query parameter. *Failure direction: cosmetic* — the
  buyer retypes an address we already hold.
- **S6 — shipping address duplication.** `PaymentLegacy` carries `shipping_address`, so
  Whop's page may collect one we already have. *Failure direction: cosmetic, but a
  checkout-abandonment risk worth measuring.*

**Do not add a configurable scale factor to "fix" S1 or S2.** A scale factor is a knob that
can silently disable the only check standing between us and a mispriced charge.

---

## 11. Non-goals

- Subscriptions, memberships, saved payment methods, Whop promo codes. Our `discounts`
  module owns promotions and now works end-to-end (§3.1).
- Mirroring the catalog into Whop products. It buys nothing pricing needs and reintroduces
  the sync-outage class this migration removes.
- The `disputes`, `invoices` and `fulfilment` modules. Still empty placeholders.
- `apps/worker`. Still the largest gap in the platform, still separate work.
