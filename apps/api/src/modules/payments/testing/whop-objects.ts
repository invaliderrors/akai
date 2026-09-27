import type { Whop } from "@whop/sdk";

/**
 * Minimal-but-REAL Whop objects for tests.
 *
 * Typed with the SDK's own types, so if an upgrade adds a required field the
 * fixtures stop compiling instead of silently describing a shape Whop no longer
 * sends.
 *
 * MONEY IS A `Money` ENVELOPE, NOT A NUMBER, and the distinction is the whole
 * reason these builders exist rather than object literals at each call site.
 * Whop's REST plane carries `{ amount: "49.99", currency, decimals,
 * display_decimals }` — an exact decimal STRING in MAJOR units, which is the
 * opposite of our own integer-minor ledger. `whopMoney` below is the only place
 * a test constructs one, so a fixture cannot quietly express €49.99 as `4999`
 * and pass against a shape the boundary would reject.
 */

/**
 * Build a `Money` from OUR minor units, so a test says what it means.
 *
 * `whopMoney(4999)` reads as "the provider reported the same €49.99 our ledger
 * holds", which is the assertion most settlement tests are actually making.
 */
export function whopMoney(minor: number, currency = "eur", decimals = 2): Whop.Money {
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : `.${digits.slice(digits.length - decimals)}`;

  return {
    amount: `${negative ? "-" : ""}${whole}${fraction}`,
    currency,
    decimals,
    display_decimals: decimals,
  };
}

export function whopPayment(overrides: Partial<Whop.Payment> = {}): Whop.Payment {
  return {
    id: "pay_test_1",
    account_id: "biz_test",
    amount_after_fees: whopMoney(4700),
    auto_refunded: false,
    billing_address: null,
    billing_reason: null,
    checkout_configuration_id: "ch_test_1",
    client_secret: null,
    created_at: "2026-09-09T10:00:00.000Z",
    currency: "eur",
    customer_phone: null,
    decline_code: null,
    dispute_alerted_at: null,
    failure_message: null,
    financing_installments_count: null,
    last_payment_attempt_at: null,
    member_id: null,
    membership_id: null,
    metadata: {},
    needs_tracking: null,
    next_payment_attempt_at: null,
    paid_at: "2026-09-09T10:00:00.000Z",
    payment_instrument: null,
    payment_method_id: null,
    payment_method_type: null,
    payments_failed: 0,
    plan_id: "plan_test_1",
    product_id: "prod_test_1",
    promo_code_id: null,
    refundable: true,
    refunded_amount: null,
    refunded_at: null,
    retryable: false,
    risk_score: null,
    risk_signals: null,
    settlement_time_at: null,
    shipment_id: null,
    shipping_address: null,
    status: "paid",
    substatus: "succeeded",
    subtotal: whopMoney(4999),
    tax_amount: null,
    tax_behavior: "inclusive",
    tax_refunded_amount: whopMoney(0),
    three_ds_verified: false,
    total: whopMoney(4999),
    updated_at: "2026-09-09T10:00:00.000Z",
    usd_total: null,
    user: null,
    verification_checks: null,
    voidable: false,
    ...overrides,
  };
}
