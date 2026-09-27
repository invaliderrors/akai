import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  checkoutSessionResponseSchema,
  type CreateCheckoutSession,
  type Order,
} from "@akai/contracts";
import type { z } from "zod";

import type { CartActor } from "../cart/cart-actor";
import { CartService } from "../cart/cart.service";
import { ProductInventoryService } from "../catalog/product-inventory.service";
import { OrdersService, type OrderFulfilmentSnapshot } from "../orders/orders.service";
import { PaymentsService } from "../payments/payments.service";
import { qualifyingSubtotal } from "../shipping/free-shipping";
import { ShippingService } from "../shipping/shipping.service";
import {
  ServicePointsService,
  type ServicePointSnapshot,
} from "../shipping/service-points/service-points.service";
import {
  CHECKOUT_CATALOG_PORT,
  type CheckoutCatalogPort,
} from "./checkout-catalog.port";

export type CheckoutSessionResponse = z.infer<typeof checkoutSessionResponseSchema>;

/**
 * CheckoutService depends on the narrowest slice of each collaborator it
 * actually calls, expressed as `Pick<>` of the real service.
 *
 * Two things fall out of that, both deliberate. The compiler still checks the
 * calls against the REAL signatures — a changed `createFromCart` shape breaks
 * here — so nothing silently drifts. And because a `Pick` type carries none of a
 * class's private members, a plain in-memory double satisfies it with no
 * `as unknown as` cast, which is what keeps this orchestration unit-testable
 * without a database (the same reason every other module here injects a port).
 * Nest still resolves each by its class token via the explicit `@Inject` below.
 */
export type CheckoutCartPort = Pick<CartService, "getOrCreateCart" | "clearCart">;
export type CheckoutShippingPort = Pick<ShippingService, "resolveCharge">;
export type CheckoutInventoryPort = Pick<ProductInventoryService, "reserve" | "release">;
export type CheckoutOrdersPort = Pick<OrdersService, "createFromCart">;
export type CheckoutPaymentsPort = Pick<PaymentsService, "startCheckout">;
export type CheckoutServicePointPort = Pick<ServicePointsService, "verifyForCheckout">;

/**
 * How long stock is withheld for an in-flight checkout.
 *
 * Capped at 1800s by the reserve schema. This is deliberately GENEROUS, but the
 * hosted checkout's own lifetime is not documented by the Whop SDK and we do not
 * pin one ourselves (the Stripe path's `CHECKOUT_TTL` had no analogue on either
 * successor and was deleted rather than invented). So the two windows are
 * UNRELATED, which is tracked in followUps: if a customer pays after the
 * reservation lapses, the sale is still recorded but the stock decrement can no
 * longer be guaranteed. Measuring the real session lifetime, then aligning the
 * two (and widening the reserve cap), is the fix.
 */
const RESERVATION_TTL_SECONDS = 1800;

/**
 * CheckoutService — the missing bridge between a validated cart and a hosted
 * checkout session. This is the single most important e-commerce path, and until
 * now it did not exist end-to-end: OrdersService.createFromCart,
 * ProductInventoryService.reserve and PaymentsService.startCheckout were each
 * built and tested in isolation but nothing called them in sequence.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN, not an accident:
 *
 *  1. Resolve the caller's OWN cart (never a client-named one) and refuse it if
 *     it carries a blocking problem — the customer must not discover an
 *     out-of-stock line after their card is charged.
 *  2. Price shipping server-side from the destination. The API never accepts a
 *     shipping amount from the client (spec §13). For a pickup-point rate,
 *     RE-VERIFY the chosen point with Sendcloud (carrier, country, expiry,
 *     availability — Sendcloud spec §3.3); a HOME rate must carry no point.
 *  3. RESERVE stock for every line first. `reserve` is the atomic oversell
 *     guard: two buyers of the last unit cannot both pass it. If any line fails,
 *     every reservation already taken is released — a half-reserved checkout
 *     must not strand stock.
 *  4. Create the immutable order, which RE-PRICES every line from the live
 *     variant. No amount from this method reaches that computation.
 *  5. Bind the reservations to the order so the PAID webhook can convert them to
 *     a sale, then consume the cart.
 *  6. Open the hosted session. The order is already PENDING and payable, so a
 *     gateway outage here is recoverable (staff re-issue) rather than a lost sale.
 *
 * NO AMOUNT IS EVER TRUSTED FROM THE CLIENT. The DTO cannot even express one.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(CartService) private readonly cart: CheckoutCartPort,
    @Inject(ShippingService) private readonly shipping: CheckoutShippingPort,
    @Inject(ProductInventoryService) private readonly inventory: CheckoutInventoryPort,
    @Inject(OrdersService) private readonly orders: CheckoutOrdersPort,
    @Inject(PaymentsService) private readonly payments: CheckoutPaymentsPort,
    @Inject(CHECKOUT_CATALOG_PORT) private readonly catalog: CheckoutCatalogPort,
    @Inject(ServicePointsService) private readonly servicePoints: CheckoutServicePointPort,
  ) {}

  async startCheckout(
    actor: CartActor,
    request: CreateCheckoutSession,
  ): Promise<CheckoutSessionResponse> {
    const { cart } = await this.cart.getOrCreateCart(actor);

    // The client states which cart it believes it is paying for; we only ever
    // act on the one the ACTOR owns. A mismatch means the stated cart is not
    // theirs — 404, never 403, so it cannot be used to probe which cart ids
    // exist (the cart module's ownership model throughout).
    if (cart.id !== request.cartId) {
      throw new NotFoundException("Cart not found");
    }

    if (cart.items.length === 0) {
      throw new UnprocessableEntityException("Cannot check out an empty cart.");
    }

    // PRICE_CHANGED is deliberately NOT blocking: the order re-prices to the
    // live figure and the customer is shown the change (spec §13). Every other
    // problem — out of stock, withdrawn product, over-max, country-restricted —
    // must be resolved on the cart page first.
    const blocking = cart.problems.filter((problem) => problem.code !== "PRICE_CHANGED");
    if (blocking.length > 0) {
      throw new UnprocessableEntityException({
        message: "Resolve the cart problems before checking out.",
        problems: blocking,
      });
    }

    const currency = cart.totals.currency;
    // THE SAME basis `POST /v1/shipping/quote` uses (via
    // `CartService.getShippingBasis`): counted lines only, after discount. It
    // used to be the raw sum of `lineTotalGross` — before discount and over
    // every line — so a discounted cart could be quoted one shipping price and
    // charged another. One owner now, `qualifyingSubtotal`.
    const grossSubtotal = qualifyingSubtotal(cart.totals);
    const weights = await this.catalog.loadVariantWeights(
      cart.items.map((item) => item.variantId),
    );
    const totalWeightGrams = cart.items.reduce(
      (total, item) => total + (weights.get(item.variantId) ?? 0) * item.quantity,
      0,
    );

    // Resolved BEFORE any stock is held: a destination we do not ship to, or a
    // forged method id, must fail the checkout before it withholds inventory.
    const shipping = await this.shipping.resolveCharge({
      countryCode: request.shippingAddress.countryCode,
      currency,
      subtotalGross: grossSubtotal,
      weightGrams: totalWeightGrams,
      shippingMethodId: request.shippingMethodId,
      // The locale the customer is buying in, so the method name stamped onto
      // the order — and inherited by the confirmation email and the invoice —
      // is in their language rather than the database's authoring language.
      locale: request.locale,
    });

    // ALSO before any stock is held: a missing, foreign, expired or closed
    // pickup point — or Sendcloud being unreachable — refuses the checkout with
    // a coded reason and no side effects, so the customer can simply pick
    // another point and resubmit.
    const servicePoint = await this.servicePoints.verifyForCheckout({
      fulfilment: shipping.fulfilment,
      servicePointId: request.servicePointId,
      countryCode: request.shippingAddress.countryCode,
    });
    const fulfilment = fulfilmentSnapshot(
      shipping,
      servicePoint,
      totalWeightGrams,
      request.shippingAddress.houseNumber,
    );

    const reservationIds = await this.reserveAll(cart.id, cart.items);
    // `createFromCart` finds these reservations by the cart id they were opened
    // against and binds them to the order it creates (so the sale-completed path
    // can commit them), re-prices every line and applies destination VAT — all
    // derived from the cart itself. This method supplies identity, addresses and
    // the server-resolved shipping charge; it never supplies an amount. The
    // `reservationIds` are held only to release them if creation is refused.
    const order = await this.createOrder(actor, request, shipping, fulfilment, reservationIds);

    // The immutable order now exists and owns the held stock, so the cart is
    // consumed. Clearing here — not after the gateway call — is what stops a double-submit
    // from reserving the same stock twice and creating a second order.
    await this.cart.clearCart(actor);

    // Last, because everything above is our own state and this is the one
    // network call. The order is already PENDING and payable, so if the gateway is
    // degraded the reservation still protects the stock and the session can be
    // re-issued (staff endpoint) rather than the sale being lost.
    return this.payments.startCheckout(order.id);
  }

  /**
   * Create the immutable order, releasing every held reservation if creation is
   * refused (an empty-cart race, a variant withdrawn mid-checkout, a currency
   * clash). The re-price happens INSIDE `createFromCart`; no figure from this
   * method reaches it.
   */
  private async createOrder(
    actor: CartActor,
    request: CreateCheckoutSession,
    shipping: Awaited<ReturnType<ShippingService["resolveCharge"]>>,
    fulfilment: OrderFulfilmentSnapshot,
    reservationIds: readonly string[],
  ): Promise<Order> {
    try {
      return await this.orders.createFromCart({
        cartId: request.cartId,
        customerId: actor.customerId,
        email: request.email,
        locale: request.locale,
        shippingAddress: request.shippingAddress,
        billingAddress: request.billingAddress ?? request.shippingAddress,
        shipping: shipping.charge,
        shippingMethodName: shipping.methodName,
        acceptedTermsVersion: request.acceptedTermsVersion,
        vatNumber: request.vatNumber,
        fulfilment,
      });
    } catch (error) {
      await this.releaseAll(reservationIds);
      throw error;
    }
  }

  /**
   * Reserve every line, or none. A failure part-way releases what was already
   * taken and rethrows the original stock error unchanged (a `CatalogError`,
   * which already carries the right HTTP status and message).
   */
  private async reserveAll(
    cartId: string,
    items: readonly { readonly variantId: string; readonly quantity: number }[],
  ): Promise<string[]> {
    const reservationIds: string[] = [];
    try {
      for (const item of items) {
        const reservation = await this.inventory.reserve({
          variantId: item.variantId,
          quantity: item.quantity,
          cartId,
          ttlSeconds: RESERVATION_TTL_SECONDS,
        });
        reservationIds.push(reservation.reservationId);
      }
    } catch (error) {
      await this.releaseAll(reservationIds);
      throw error;
    }
    return reservationIds;
  }

  private async releaseAll(reservationIds: readonly string[]): Promise<void> {
    for (const reservationId of reservationIds) {
      await this.inventory.release(reservationId);
    }
  }
}

/**
 * Everything the label will need, frozen at checkout (Sendcloud spec §3.3):
 * the chosen rate and its option code AT THIS MOMENT, the parcel weight from
 * the same weights shipping was priced with, the separate house number, and
 * the re-verified pickup point (all null for a HOME rate).
 */
function fulfilmentSnapshot(
  shipping: Awaited<ReturnType<ShippingService["resolveCharge"]>>,
  servicePoint: ServicePointSnapshot | null,
  parcelWeightGrams: number,
  houseNumber: string,
): OrderFulfilmentSnapshot {
  const trimmedHouseNumber = houseNumber.trim();
  return {
    shippingRateId: shipping.rateId,
    sendcloudOptionCode: shipping.fulfilment.sendcloudOptionCode,
    parcelWeightGrams,
    shipHouseNumber: trimmedHouseNumber === "" ? null : trimmedHouseNumber,
    servicePointId: servicePoint?.servicePointId ?? null,
    servicePointCarrierId: servicePoint?.servicePointCarrierId ?? null,
    servicePointName: servicePoint?.servicePointName ?? null,
    servicePointAddress: servicePoint?.servicePointAddress ?? null,
    servicePointPostNumber: servicePoint?.servicePointPostNumber ?? null,
  };
}
