import { Inject, Injectable } from "@nestjs/common";
import type { CurrencyCode, DiscountType, Minor } from "@akai/contracts";

import { calculateDiscountAmount } from "./discount-calculator";
import {
  DISCOUNTS_REPOSITORY,
  type DiscountsRepository,
  type RecordRedemptionInput,
} from "./discounts.repository";
import { DiscountError } from "./discounts.errors";

/**
 * A clock, injected so the validity-window checks are provable without the suite
 * waiting for a coupon to expire in real time.
 */
export interface DiscountClock {
  now(): Date;
}
export const DISCOUNTS_CLOCK = Symbol("DISCOUNTS_CLOCK");
export const systemDiscountClock: DiscountClock = { now: () => new Date() };

export interface DiscountValidationInput {
  readonly code: string;
  /** Gross subtotal, already recomputed from live variants. */
  readonly subtotalGross: Minor;
  readonly currency: CurrencyCode;
  /** Null for a guest — per-customer caps cannot apply to an untracked buyer. */
  readonly customerId: string | null;
}

export interface ValidatedDiscount {
  readonly discountId: string;
  readonly code: string;
  readonly type: DiscountType;
  /** Gross discount to apply to the subtotal, in minor units. */
  readonly amount: Minor;
}

/**
 * DiscountsService — coupon validation and redemption accounting.
 *
 * Server-side only; a client-applied discount is advisory (spec §13). The two
 * jobs are deliberately separate:
 *
 *  * `validate` decides whether a code may be applied to a basket AND how much
 *    it removes. It THROWS a typed DiscountError with a stable `reason` on every
 *    failure mode, so the UI can distinguish "expired" from "spend more". It
 *    does NOT record anything — pricing a cart must be side-effect-free, or a
 *    shopper refreshing their cart would burn a single-use code.
 *  * `recordRedemption` consumes the allowance. It belongs to the order-creation
 *    transaction (checkout), never to cart pricing, and the write races it must
 *    survive are closed in the schema (unique (discountId, orderId)) and by a
 *    lock-taking increment, not by application-level checks.
 *
 * Codes are matched case-insensitively (normalised to upper-case) so "SAVE10"
 * and "save10" are the same coupon — anything else is a support ticket.
 */
@Injectable()
export class DiscountsService {
  constructor(
    @Inject(DISCOUNTS_REPOSITORY) private readonly repository: DiscountsRepository,
    @Inject(DISCOUNTS_CLOCK) private readonly clock: DiscountClock,
  ) {}

  async validate(input: DiscountValidationInput): Promise<ValidatedDiscount> {
    const code = input.code.trim().toUpperCase();
    if (code.length === 0) {
      throw DiscountError.invalidCode();
    }

    const discount = await this.repository.findActiveByCode(code);
    if (discount === null) {
      throw DiscountError.invalidCode();
    }

    const now = this.clock.now();
    if (discount.startsAt !== null && discount.startsAt > now) {
      throw DiscountError.notActive();
    }
    if (discount.endsAt !== null && discount.endsAt <= now) {
      throw DiscountError.expired();
    }

    // A code minted in one currency cannot be honoured against a basket in
    // another — €10 off is not $10 off. A null currency means "any".
    if (discount.currency !== null && discount.currency !== input.currency) {
      throw DiscountError.currencyMismatch();
    }

    if (
      discount.minimumSubtotal !== null &&
      input.subtotalGross < discount.minimumSubtotal
    ) {
      throw DiscountError.belowMinimum();
    }

    if (
      discount.maxRedemptions !== null &&
      discount.timesRedeemed >= discount.maxRedemptions
    ) {
      throw DiscountError.usageLimitReached();
    }

    // Per-customer caps only bind a known customer. A guest is untracked, so the
    // global cap is the only bound available — recorded here rather than silently
    // waived, because it is a real (documented) limitation, not an oversight.
    if (discount.maxRedemptionsPerCustomer !== null && input.customerId !== null) {
      const used = await this.repository.countCustomerRedemptions(
        discount.id,
        input.customerId,
      );
      if (used >= discount.maxRedemptionsPerCustomer) {
        throw DiscountError.usageLimitReached();
      }
    }

    const amount = calculateDiscountAmount(
      { type: discount.type, value: discount.value },
      input.subtotalGross,
    );

    return {
      discountId: discount.id,
      code: discount.code,
      type: discount.type,
      amount,
    };
  }

  /**
   * Consume one redemption. Called from the order-creation transaction, never
   * from cart pricing. Left as an exported method the checkout flow wires in;
   * the redemption row is what a later per-line discount snapshot reads back.
   */
  recordRedemption(input: RecordRedemptionInput): Promise<void> {
    return this.repository.recordRedemption(input);
  }
}
