import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { Minor } from "@akai/contracts";
import { ZERO } from "@akai/money";

import type {
  CartDiscountContext,
  CartDiscountPort,
  CartDiscountResult,
} from "../cart/cart-discount.port";
import { DiscountsService } from "./discounts.service";
import { DiscountError } from "./discounts.errors";

/**
 * The real binding for CartModule's `CART_DISCOUNT_PORT`, replacing the
 * fail-closed `NoDiscountAdapter` that always returned zero.
 *
 * WHY IT SWALLOWS DiscountError BUT NOTHING ELSE: pricing a cart must never 500
 * because the code stored on it has since expired or hit its cap. A shopper whose
 * "SAVE10" lapsed should see their cart at full price, not an error page — so a
 * *validation* failure degrades to no discount. But a genuine fault (the database
 * is down) is NOT a "no discount" situation; letting it through as ZERO would
 * quietly charge full price during an outage and hide the incident. Those
 * propagate.
 *
 * This adapter only PRICES; it records nothing. A cart is re-priced on every
 * read, and recording a redemption here would burn a single-use code the moment
 * the shopper refreshed. Redemption is DiscountsService.recordRedemption's job,
 * inside the checkout transaction.
 */
@Injectable()
export class DiscountsCartAdapter implements CartDiscountPort {
  constructor(private readonly discounts: DiscountsService) {}

  async resolveDiscount(context: CartDiscountContext): Promise<Minor> {
    if (context.discountCode === null) {
      return ZERO;
    }

    try {
      const validated = await this.discounts.validate({
        code: context.discountCode,
        subtotalGross: context.subtotal,
        currency: context.currency,
        customerId: context.customerId,
      });
      return validated.amount;
    } catch (error) {
      if (error instanceof DiscountError) {
        return ZERO;
      }
      throw error;
    }
  }

  /**
   * The APPLY path: validate and PROPAGATE the failure. This is the deliberate
   * difference from `resolveDiscount` above — when a customer explicitly applies a
   * code, a DiscountError (expired, at cap, below minimum, wrong currency) must
   * reach them as a 422 with its reason, not be swallowed into "no discount".
   */
  async validate(context: CartDiscountContext): Promise<CartDiscountResult> {
    if (context.discountCode === null) {
      throw new UnprocessableEntityException("No discount code was provided.");
    }

    const validated = await this.discounts.validate({
      code: context.discountCode,
      subtotalGross: context.subtotal,
      currency: context.currency,
      customerId: context.customerId,
    });
    return { code: validated.code, amount: validated.amount };
  }
}
