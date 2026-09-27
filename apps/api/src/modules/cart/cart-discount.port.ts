import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { Minor } from "@akai/contracts";
import { ZERO } from "@akai/money";

/**
 * The seam between the cart and the discounts module.
 *
 * `cart.discountCode` exists in the schema and `cartTotals.discountTotal` exists
 * on the wire, so the cart must have SOMETHING to ask. DiscountsModule is owned
 * by another agent in this pass, so rather than reaching into it — or, worse,
 * hardcoding `discountTotal: 0` and leaving a silently-wrong total behind for
 * someone to discover — the dependency is expressed as a port with a null
 * implementation.
 *
 * When DiscountsModule lands it binds a real provider to CART_DISCOUNT_PORT and
 * cart totals start honouring codes with no change to CartService. See followUps.
 */

export interface CartDiscountContext {
  readonly cartId: string;
  readonly customerId: string | null;
  readonly currency: string;
  readonly discountCode: string | null;
  /** Gross subtotal, already recomputed from live variants. */
  readonly subtotal: Minor;
}

/** The result of validating a code for a basket. */
export interface CartDiscountResult {
  /** The canonical (normalised) code that was validated. */
  readonly code: string;
  /** Gross discount the code yields for this basket, in minor units. */
  readonly amount: Minor;
}

export interface CartDiscountPort {
  /**
   * The gross discount to apply, in minor units.
   *
   * Implementations must return a NON-NEGATIVE amount. Over-application is not
   * their problem to police: `calculateTotals` clamps the result to the subtotal
   * so a misbehaving discount rule can never drive a grand total negative. An
   * invalid or lapsed code degrades to ZERO here (pricing must never 500).
   */
  resolveDiscount(context: CartDiscountContext): Promise<Minor>;

  /**
   * Validate a code for APPLICATION to the basket.
   *
   * Unlike `resolveDiscount`, this THROWS when the code cannot apply (unknown,
   * expired, below minimum, at cap, wrong currency) so the customer applying a
   * coupon learns WHY rather than seeing it silently ignored. Used only on the
   * explicit "apply code" action, never on pricing.
   */
  validate(context: CartDiscountContext): Promise<CartDiscountResult>;
}

export const CART_DISCOUNT_PORT = Symbol("CART_DISCOUNT_PORT");

/**
 * Default binding: no discount, ever.
 *
 * Chosen so the un-wired state fails CLOSED. The alternative default — trusting
 * a code we cannot yet validate — would hand out unlimited money.
 */
@Injectable()
export class NoDiscountAdapter implements CartDiscountPort {
  async resolveDiscount(): Promise<Minor> {
    return ZERO;
  }

  /**
   * No discounts are configured, so every code is invalid. Fails CLOSED — a
   * store with no discounts binding must reject an applied code, never accept it.
   */
  async validate(): Promise<never> {
    throw new UnprocessableEntityException("That discount code is not valid.");
  }
}
