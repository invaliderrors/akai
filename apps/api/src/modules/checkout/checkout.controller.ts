import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createCheckoutSessionSchema,
  type CreateCheckoutSession,
} from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { CurrentCartActor, type CartActor } from "../cart/cart-actor";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  CheckoutService,
  type CheckoutSessionResponse,
} from "./checkout.service";

/**
 * The response, as a schema.
 *
 * Needed because an idempotent REPLAY reads the stored snapshot back out of a
 * `Json` column, and that snapshot is external data by the time it comes back —
 * we wrote it, but a deploy may have changed the shape in between. Parsing it
 * means a schema change fails loudly instead of handing a client a `checkoutUrl`
 * that is `undefined`.
 */
const checkoutSessionResponseSchema = z
  .object({
    orderNumber: z.string(),
    checkoutUrl: z.string(),
  })
  .strict();

/**
 * Checkout HTTP surface — the public "pay for my cart" route.
 *
 * `@Public()` for the same reason the cart routes are: a guest must be able to
 * buy without an account (spec §8). It is NOT unauthenticated in the sense that
 * matters — ownership of the cart is proven by the CART ACTOR (session or
 * anonymous token), never by a client-supplied id. The request names a `cartId`
 * only as a cross-check; CheckoutService acts solely on the cart the actor owns
 * and refuses a mismatch.
 *
 * Note what is absent: any amount, price, or total. The DTO cannot express one,
 * and the grand total is recomputed server-side inside `createFromCart`.
 *
 * TWO CONTROLS ARE MANDATORY HERE, because this is the only money-creating POST
 * in the platform:
 *
 *  * IDEMPOTENCY. A retried POST — proxy timeout, a double-clicked button, a
 *    mobile browser replaying on reconnect — would otherwise reserve stock
 *    twice, create two orders and open two payment sessions. The
 *    `Idempotency-Key` header must be READ, not merely allowed through CORS.
 *  * THROTTLING. The tightest non-contact bucket. A burst here is either the
 *    double-submit idempotency now absorbs, or an attack.
 */
@ApiTags("checkout")
@Controller("checkout")
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.checkout)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description:
      "Client-generated key. A retry with the same key replays the stored " +
      "response; the same key with a different body is a 409.",
  })
  @ApiOperation({
    summary: "Reserve stock, create the order, and open a Whop checkout session",
  })
  async start(
    @CurrentCartActor() actor: CartActor,
    @Body(new ZodValidationPipe(createCheckoutSessionSchema))
    body: CreateCheckoutSession,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<CheckoutSessionResponse> {
    const key = idempotencyKey?.trim();

    // OPTIONAL, deliberately. Making the header mandatory would break every
    // existing client the day it shipped, and would turn a missing header into a
    // failed purchase — the worst available failure mode for the one route that
    // takes money. A caller that sends a key gets replay protection; a caller
    // that does not gets exactly the behaviour it had before.
    if (key === undefined || key.length === 0) {
      return this.checkout.startCheckout(actor, body);
    }

    const result = await this.idempotency.execute({
      key,
      userId: idempotencyScope(actor),
      route: "POST /checkout",
      request: body,
      responseSchema: checkoutSessionResponseSchema,
      handler: () => this.checkout.startCheckout(actor, body),
    });

    return result.value;
  }
}

/**
 * The scope an idempotency key is unique WITHIN.
 *
 * The reservation's primary key is `(key, userId, route)`, so this value decides
 * whose keys may collide. Two properties matter:
 *
 *  1. It must not be global. A guest picking the key "1" would otherwise replay
 *     a stranger's checkout response — order number, checkout URL and all.
 *  2. It must not be the RAW cart token. That token is a bearer credential, and
 *     `idempotency_record.userId` is a plain column with a 24-hour TTL and no
 *     encryption; writing a live credential there puts it somewhere it was never
 *     meant to be. The SHA-256 is one-way, stable for the life of the token, and
 *     just as good a partition key.
 *
 * A signed-in customer scopes by customer id, which additionally makes the key
 * survive a cart-token rotation mid-session.
 *
 * Exported and pure so the partitioning is assertable directly.
 */
export function idempotencyScope(actor: CartActor): string {
  if (actor.customerId !== null) {
    return actor.customerId;
  }
  if (actor.cartToken !== null) {
    const digest = createHash("sha256").update(actor.cartToken).digest("hex");
    return `guest:${digest.slice(0, 32)}`;
  }
  // No session and no cart token: the caller cannot own a cart, so checkout is
  // about to fail regardless. A constant scope is safe here precisely because no
  // successful response can ever be stored under it.
  return "guest:anonymous";
}
