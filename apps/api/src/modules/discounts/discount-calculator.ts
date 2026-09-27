import type { DiscountType, Minor } from "@akai/contracts";
import { ZERO, applyBasisPoints, toMinor } from "@akai/money";

/**
 * Discount amount computation — a PURE function over a discount rule and a
 * subtotal.
 *
 * Kept free of Nest and Prisma because, like every other money path in this
 * codebase, it decides how much to charge and therefore must be exhaustively
 * testable without a database. Validity (window, currency, redemption caps) is
 * NOT its concern — that is DiscountsService's job. This only answers: given a
 * valid rule and a subtotal, how much comes off?
 *
 * The value column is overloaded by type (as the schema documents):
 *  * PERCENTAGE    — `value` is BASIS POINTS (1000 = 10%). Applied to the gross
 *    subtotal via @akai/money's half-up basis-point helper.
 *  * FIXED_AMOUNT  — `value` is MINOR UNITS off, capped at the subtotal.
 *  * FREE_SHIPPING — no subtotal discount at all. The effect is on shipping, and
 *    the cart stage has no shipping, so this contributes ZERO here. (Honouring a
 *    free-shipping code at checkout is a shipping-module concern; see followUps.)
 *
 * EVERY RESULT IS CLAMPED TO THE SUBTOTAL. A 150%-off code, or a €50 fixed
 * discount on a €30 basket, can never drive the line negative — the classic path
 * to a successful zero-amount charge or a refund the gateway will not process. The
 * cart totals clamp again as defence in depth, but the discount engine must not
 * emit garbage in the first place.
 */

export interface DiscountRule {
  readonly type: DiscountType;
  /** PERCENTAGE: basis points. FIXED_AMOUNT: minor units. FREE_SHIPPING: unused. */
  readonly value: number;
}

export function calculateDiscountAmount(rule: DiscountRule, subtotalGross: Minor): Minor {
  if (!Number.isInteger(rule.value) || rule.value < 0) {
    throw new RangeError(
      `Discount value must be a non-negative integer; got ${rule.value}. ` +
        `A malformed discount rule must fail loudly, never silently discount by zero or more.`,
    );
  }

  const raw = computeRaw(rule, subtotalGross);
  // Clamp: a discount can never exceed the subtotal it applies to.
  return raw > subtotalGross ? subtotalGross : raw;
}

function computeRaw(rule: DiscountRule, subtotalGross: Minor): Minor {
  switch (rule.type) {
    case "PERCENTAGE":
      return applyBasisPoints(subtotalGross, rule.value);
    case "FIXED_AMOUNT":
      return toMinor(rule.value);
    case "FREE_SHIPPING":
      return ZERO;
  }
}
