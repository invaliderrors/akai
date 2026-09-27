import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Cart } from "@akai/contracts";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { CurrentCartActor, type CartActor } from "./cart-actor";
import { CART_TOKEN_HEADER } from "./cart.constants";
import {
  addCartItemSchema,
  addPackToCartSchema,
  applyDiscountSchema,
  cartLocaleQuerySchema,
  mergeCartSchema,
  updateCartItemSchema,
  validateCartSchema,
  type AddCartItemDto,
  type AddPackToCartDto,
  type ApplyDiscountDto,
  type CartLocaleQueryDto,
  type MergeCartDto,
  type UpdateCartItemDto,
  type ValidateCartDto,
} from "./cart.dto";
import { CartService, type CartView } from "./cart.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

/**
 * Cart HTTP surface.
 *
 * WHY THESE ROUTES ARE `@Public()`: the API is deny-by-default (spec §8), but a
 * storefront must let an anonymous visitor build a basket before it asks them to
 * sign in — forcing authentication to add to cart is a conversion cliff. Public
 * here means "no session required", NOT "no authorization": every handler goes
 * through CartService, which proves the caller owns the cart it returns. When an
 * authenticated session IS present, the guard populates `request.user` and the
 * actor picks it up automatically.
 *
 * `POST /cart/merge` is the deliberate exception and is NOT public — merging is
 * only meaningful for a signed-in customer, and leaving it public would let an
 * unauthenticated caller feed tokens to it.
 *
 * NOTE: no endpoint here accepts a cart id. The caller's cart is derived from
 * their session or their token, never named in the request, which removes the
 * IDOR surface rather than defending it.
 *
 * `@Public()` IS NOT THE SAME AS UNLIMITED. `ThrottleGuard` bounds the write
 * verbs per client. An unauthenticated endpoint is exactly the surface where a
 * limiter matters most, and until ThrottlerModule was implemented there was no
 * limit of any kind on this controller.
 *
 * EVERY route takes `?locale=`. It is a presentation concern — nothing about it
 * is stored — but it has to be honoured on the writes as well as the reads,
 * because every mutation returns the whole re-rendered cart.
 */
@ApiTags("cart")
@Controller("cart")
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "Fetch the current cart, creating one if needed" })
  async getCart(
    @CurrentCartActor() actor: CartActor,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(
      await this.cart.getOrCreateCart(actor, query.locale),
      response,
    );
  }

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.cartWrite)
  @Post("items")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add a variant to the cart (increments an existing line)" })
  async addItem(
    @CurrentCartActor() actor: CartActor,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Body(new ZodValidationPipe(addCartItemSchema)) body: AddCartItemDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(await this.cart.addItem(actor, body, query.locale), response);
  }

  /**
   * `ParseUUIDPipe` runs before the handler, so a non-uuid item id is a 400 and
   * never reaches a database lookup.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.cartWrite)
  @Patch("items/:itemId")
  @ApiOperation({ summary: "Set a line quantity. Zero removes the line." })
  async updateItem(
    @CurrentCartActor() actor: CartActor,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Body(new ZodValidationPipe(updateCartItemSchema))
    body: UpdateCartItemDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(
      await this.cart.updateItemQuantity(actor, itemId, body, query.locale),
      response,
    );
  }

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.cartWrite)
  @Delete("items/:itemId")
  @ApiOperation({ summary: "Remove a line from the cart" })
  async removeItem(
    @CurrentCartActor() actor: CartActor,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(
      await this.cart.removeItem(actor, itemId, query.locale),
      response,
    );
  }

  /**
   * "Add pack to cart" — a SEPARATE route from `POST items`, not the same one
   * with a discriminated body, because the two resolve completely
   * differently server-side: this expands into N real component lines and
   * never creates a line for the pack's own variant. See `CartService.addPack`.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.cartWrite)
  @Post("packs")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add a pack to the cart (writes its real components as real lines)" })
  async addPack(
    @CurrentCartActor() actor: CartActor,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Body(new ZodValidationPipe(addPackToCartSchema)) body: AddPackToCartDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(await this.cart.addPack(actor, body, query.locale), response);
  }

  /**
   * Removes every component line of one pack instance atomically. A pack's
   * lines are add/remove-atomic — `DELETE items/:itemId` on one of them is
   * refused; see `CartService.assertNotPackLine`.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.cartWrite)
  @Delete("packs/:packInstanceId")
  @ApiOperation({ summary: "Remove a whole pack instance from the cart" })
  async removePack(
    @CurrentCartActor() actor: CartActor,
    @Param("packInstanceId", ParseUUIDPipe) packInstanceId: string,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(
      await this.cart.removePack(actor, packInstanceId, query.locale),
      response,
    );
  }

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.cartWrite)
  @Delete()
  @ApiOperation({ summary: "Empty the cart without deleting it" })
  async clear(
    @CurrentCartActor() actor: CartActor,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(await this.cart.clearCart(actor, query.locale), response);
  }

  /**
   * Validate the cart before checkout, returning the full cart with every
   * line-level problem populated.
   *
   * `@Public()` for the same reason the reads are: a guest builds a basket before
   * signing in, and CartService resolves the cart by OWNERSHIP (session or token),
   * never by an id in the request. The optional `countryCode` adds destination
   * restriction checks; without it the caller gets stock/availability/price
   * problems only. The cart page blocks the "pay" button while `problems` is
   * non-empty (price-changed excepted), so the customer fixes issues before the gateway
   * rather than after their card is charged.
   *
   * A read that issues no token, so no `@Res` — it never creates a cart.
   */
  @Public()
  @Post("validate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Validate the cart for checkout and surface line problems" })
  async validate(
    @CurrentCartActor() actor: CartActor,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Body(new ZodValidationPipe(validateCartSchema)) body: ValidateCartDto,
  ): Promise<Cart> {
    return this.cart.validateCart(actor, body.countryCode ?? null, query.locale);
  }

  /**
   * Apply a coupon code. `@Public()` like the rest — a guest builds and discounts
   * a basket before signing in. An invalid, expired or exhausted code is a 422
   * with a reason (CartService validates before storing); a valid one is stored
   * and the returned cart reflects the discounted total.
   *
   * Throttled on the cart-write budget for a reason specific to this route: a
   * coupon field is a CODE ORACLE, and an unlimited one lets an attacker
   * enumerate the discount table by brute force.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.cartWrite)
  @Put("discount")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Apply a discount code to the cart" })
  async applyDiscount(
    @CurrentCartActor() actor: CartActor,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
    @Body(new ZodValidationPipe(applyDiscountSchema)) body: ApplyDiscountDto,
  ): Promise<Cart> {
    return this.cart.applyDiscountCode(actor, body.code, query.locale);
  }

  @Public()
  @Delete("discount")
  @ApiOperation({ summary: "Remove the applied discount code from the cart" })
  async removeDiscount(
    @CurrentCartActor() actor: CartActor,
    @Query(new ZodValidationPipe(cartLocaleQuerySchema)) query: CartLocaleQueryDto,
  ): Promise<Cart> {
    return this.cart.removeDiscountCode(actor, query.locale);
  }

  /**
   * Merge-on-login. NOT `@Public()` — see the class comment.
   *
   * CartService independently rejects an actor with no customerId, so this
   * endpoint is safe even if the global guard is misconfigured. Two checks, on
   * the assumption that one of them will eventually be wrong.
   */
  @Post("merge")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Fold an anonymous cart into the signed-in customer's cart" })
  async merge(
    @CurrentCartActor() actor: CartActor,
    @Body(new ZodValidationPipe(mergeCartSchema)) body: MergeCartDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Cart> {
    return this.respond(await this.cart.mergeGuestCart(actor, body), response);
  }

  /**
   * A freshly minted token leaves in a RESPONSE HEADER, never in the body.
   *
   * It is a bearer credential, and response bodies are the thing that gets
   * cached by a CDN, logged by an APM and pasted into a bug report. The header
   * is set only on the request that created the cart; reads never re-issue it.
   *
   * For a BROWSER to read this header the API must also list it in CORS
   * `exposedHeaders`. Omit it there and a browser-side cart cannot work at all —
   * the header is sent, and silently unreadable. See main.ts.
   */
  private respond(view: CartView, response: Response): Cart {
    if (view.issuedToken !== null) {
      response.setHeader(CART_TOKEN_HEADER, view.issuedToken);
    }
    return view.cart;
  }
}
