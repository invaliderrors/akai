import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  type FreeShippingThresholdResponse,
  shippingQuoteRequestSchema,
  type ShippingQuoteRequest,
  type ShippingQuoteResponse,
} from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CurrentCartActor, type CartActor } from "../cart/cart-actor";
import { CartService } from "../cart/cart.service";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { ShippingError } from "./shipping.errors";
import { ShippingService } from "./shipping.service";
import { toShippingQuote } from "./shipping.mapper";

/**
 * The public shipping surface — one route, and it unblocks checkout.
 *
 * THE HOLE THIS FILLS: `createCheckoutSessionSchema` REQUIRES a
 * `shippingMethodId`, and that id is a `shipping_rate` row id. ShippingService
 * has been able to produce one since it was written — `listOptions()` is
 * implemented and tested — but ShippingModule registered no controller, so the
 * service was reachable only from inside `POST /v1/checkout`. A client could
 * therefore assemble every field of a valid checkout request except the one that
 * decides the price, which made checkout unreachable by construction. This
 * controller is a thin adapter over finished logic; there is no new selection or
 * pricing code anywhere in this change.
 *
 * WHY POST FOR A READ: the quote is a function of the caller's CART, which is
 * resolved from the cart actor. A GET with the destination in the query string
 * would be cached by intermediaries keyed on a URL that omits the input that
 * actually varies the answer — two shoppers with different baskets, one URL, one
 * cached price. POST is uncacheable, which here is the correct semantics rather
 * than a workaround.
 *
 * `@Public()` because a guest prices delivery before they have an account, and
 * throttled because a public endpoint that runs a zone lookup per call is a free
 * database query for anyone who wants one.
 */
@ApiTags("shipping")
@Controller("shipping")
export class ShippingController {
  constructor(
    private readonly shipping: ShippingService,
    private readonly cart: CartService,
  ) {}

  /**
   * The destination-independent free-shipping threshold, for the cart page and
   * drawer (which know no destination yet). Null when the rates do not share
   * one. A GET, unlike the quote: the answer depends on no caller input at all,
   * so there is nothing an intermediary could cache under the wrong key.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  // The catalog-read budget, not the quote's: every cart page and drawer open
  // reads this, and it must not spend the 60/min an address form needs.
  @Throttle(THROTTLE_RULES.catalogRead)
  @Get("free-shipping")
  @ApiOperation({
    summary: "The free-shipping threshold every destination shares, or null",
  })
  async freeShipping(): Promise<FreeShippingThresholdResponse> {
    return { threshold: await this.shipping.freeShippingThreshold() };
  }

  /**
   * Price the caller's cart to a destination.
   *
   * NOTE WHAT THE BODY CANNOT SAY: no subtotal, no weight, no cart id. Those are
   * read from the actor's own cart by `CartService.getShippingBasis`. A request
   * able to state its own subtotal could buy the free-over-threshold bracket for
   * nothing; one able to state its own weight could ship 20 kg at the 500 g rate.
   *
   * "We do not ship there" comes back as a 200 with `destinationServed: false`,
   * not as an error. A shopper changing the country dropdown is asking an
   * ordinary question and deserves an ordinary answer — modelling it as a 400
   * would force every client to parse an error envelope to render a normal piece
   * of UI. `ShippingError.noMethodAvailable` is likewise flattened to an empty
   * option list with `destinationServed: true`, which is the genuinely distinct
   * second case: we ship there, but this parcel fits no bracket.
   *
   * Every OTHER ShippingError — notably `taxUnconfigured`, a real operator
   * misconfiguration — propagates untouched. Swallowing those would turn a
   * configuration incident into a silent "no shipping available".
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.shippingQuote)
  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Shipping methods and prices for the caller's cart and a destination",
  })
  async quote(
    @CurrentCartActor() actor: CartActor,
    @Body(new ZodValidationPipe(shippingQuoteRequestSchema))
    body: ShippingQuoteRequest,
  ): Promise<ShippingQuoteResponse> {
    const basis = await this.cart.getShippingBasis(actor);

    try {
      const options = await this.shipping.listOptions({
        countryCode: body.countryCode,
        currency: basis.currency,
        subtotalGross: basis.subtotalGross,
        weightGrams: basis.weightGrams,
      });

      return toShippingQuote(body.countryCode, basis, options, true);
    } catch (error: unknown) {
      if (isUnservedDestination(error)) {
        return toShippingQuote(body.countryCode, basis, [], false);
      }
      throw error;
    }
  }
}

/**
 * Narrow the one error that is a normal answer rather than a failure.
 *
 * Matched on the CLASS plus the code, never on the message: the message is
 * human-facing prose that a translation pass is free to change, and a handler
 * that branches on it silently stops branching the day someone rewords it.
 *
 * `noMethodAvailable` shares `VALIDATION_FAILED`, so the class alone is not
 * enough to tell the two apart — but both flatten to an empty option list here,
 * and only the destination case flips `destinationServed`. That distinction is
 * carried by the dedicated `isDestinationNotServed` marker below rather than by
 * string matching.
 */
function isUnservedDestination(error: unknown): boolean {
  return error instanceof ShippingError && error.isDestinationNotServed;
}
