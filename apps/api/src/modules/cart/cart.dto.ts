import { z } from "zod";
import {
  addCartItemSchema,
  addPackToCartSchema,
  countryCodeSchema,
  localeSchema,
  updateCartItemSchema,
} from "@akai/contracts";
import { CART_TOKEN_ENCODED_LENGTH, DEFAULT_CART_LOCALE } from "./cart.constants";

/**
 * Request DTOs.
 *
 * The two item schemas are RE-EXPORTED from @akai/contracts rather than
 * redeclared. That matters more than it looks: contracts is what both browser
 * apps validate against, so a locally-written copy would let the server accept a
 * quantity the client considers invalid (or vice versa) with nothing failing to
 * flag it. One declaration, one meaning.
 *
 * Note what is ABSENT from every schema here: any price, any total, any
 * currency. The client cannot express an amount to the cart API at all — the
 * server re-reads every price from the live variant. This is the single most
 * important property of the checkout path (spec §13) and it is enforced by the
 * shape of the input, not by a check someone has to remember to write.
 */

export { addCartItemSchema, addPackToCartSchema, updateCartItemSchema };

export type AddCartItemDto = z.infer<typeof addCartItemSchema>;
export type UpdateCartItemDto = z.infer<typeof updateCartItemSchema>;
export type AddPackToCartDto = z.infer<typeof addPackToCartSchema>;

/**
 * Merge-on-login payload: the anonymous token whose cart should be folded into
 * the caller's own cart.
 *
 * The token is shape-validated here as well as in CartTokenService. Doing it at
 * the boundary keeps malformed values out of an indexed hash lookup; doing it in
 * the service keeps the guarantee even if a future caller bypasses this pipe.
 */
export const mergeCartSchema = z
  .object({
    cartToken: z
      .string()
      .length(CART_TOKEN_ENCODED_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/, "Cart token must be base64url"),
  })
  .strict();

export type MergeCartDto = z.infer<typeof mergeCartSchema>;

/**
 * Validate-cart payload.
 *
 * `countryCode` is OPTIONAL: the cart page validates with no destination on load
 * (stock, availability, price movements) and re-validates with the ship-to
 * country once the customer reaches the address step, which additionally surfaces
 * `COUNTRY_RESTRICTED` lines. It carries no amount — validation, like every cart
 * operation, re-reads every price server-side.
 */
export const validateCartSchema = z
  .object({
    countryCode: countryCodeSchema.optional(),
  })
  .strict();

export type ValidateCartDto = z.infer<typeof validateCartSchema>;

/**
 * Display locale for a cart response.
 *
 * A QUERY parameter rather than a body field, because it must apply uniformly to
 * GET and DELETE as well as to the writes — and because it is a presentation
 * concern, not part of the cart's state. Nothing is persisted from it: the same
 * cart requested twice in two languages is one cart, rendered twice.
 *
 * Before this existed, `prisma-cart.repository.ts` pinned Spanish for both the
 * product name and the variant name, so an English-speaking customer's basket
 * came back as "Creatina Monohidrato" and no client could ask for anything else.
 * That is a violation of the platform's translation rule located in the API, and
 * a storefront cannot fix it by re-fetching the catalog on every cart render
 * without duplicating the whole read.
 */
export const cartLocaleQuerySchema = z
  .object({
    locale: localeSchema.default(DEFAULT_CART_LOCALE),
  })
  .strict();

export type CartLocaleQueryDto = z.infer<typeof cartLocaleQuerySchema>;

/**
 * Apply-coupon payload. Just a code — carries no amount, like every cart input.
 * The discount it yields is computed server-side against the live subtotal.
 */
export const applyDiscountSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
  })
  .strict();

export type ApplyDiscountDto = z.infer<typeof applyDiscountSchema>;
