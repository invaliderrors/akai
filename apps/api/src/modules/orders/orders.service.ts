import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  AddressFields,
  AdminOrder,
  AdminOrderSummary,
  CurrencyCode,
  Locale,
  Minor,
  Order,
  OrderSummary,
  Paginated,
  Refund,
  Shipment,
  TaxClass,
} from "@akai/contracts";
import { RecordNotFoundError, assertFound, ownedByOrderNumber } from "@akai/db";
import type { Prisma } from "@akai/db";
import { ZERO, allocate, multiply, sum, toMinor } from "@akai/money";
import { z } from "zod";

import type { ServerEnv } from "@akai/config";

import { SERVER_CONFIG } from "../config/config.module";
import { PrismaService } from "../prisma/prisma.service";
import { ProductInventoryService } from "../catalog/product-inventory.service";
import { DiscountError } from "../discounts/discounts.errors";
import {
  DiscountsService,
  type ValidatedDiscount,
} from "../discounts/discounts.service";
import {
  DESTINATION_TAX_RESOLVER,
  type DestinationTaxResolverPort,
} from "../tax/destination-tax.resolver";
import type {
  AdminOrderListQuery,
  AdminTransitionOrder,
  CreateRefundRequest,
  CreateShipmentRequest,
  CustomerOrderListQuery,
} from "./dto/orders.dto";
import {
  assertAdminMayAssign,
  assertTransition,
  isPaidStatus,
  isTerminal,
  statusAfterRefund,
} from "./order-status.machine";
import {
  type PricedLine,
  type ShippingCharge,
  priceOrder,
  refundableRemaining,
} from "./order-totals";
// The SAME allocator the cart's own live re-pricing uses — see its own doc
// comment for why one function has to serve both call sites.
import { allocatePackComponents } from "../cart/pack-pricing";
import { carriesGoods } from "./shipment-status";
import {
  ADMIN_SUMMARY_INCLUDE,
  shippingFilterWhere,
  toAdminOrderSummaryDto,
} from "./admin-order-list";
import {
  toAdminOrderDto,
  toOrderDto,
  toOrderSummaryDto,
  toRefundDto,
  toShipmentDto,
} from "./orders.mapper";
import type { Principal } from "../auth/security/principal";

/**
 * OrdersService — the only writer of `order.status` in the platform.
 *
 * Everything here holds to three rules that are worth stating before the code:
 *
 *  1. NO CLIENT AMOUNTS. `createFromCart` is a server-internal call from
 *     CheckoutModule. It re-prices every line from the live variant row and
 *     computes the grand total itself. The one client-supplied amount in the
 *     module is a refund amount, and it is bounded above by what was paid.
 *
 *  2. OWNERSHIP IS A WHERE CLAUSE, NOT AN IF. Customer reads resolve by
 *     (orderNumber AND customerId) via `ownedByOrderNumber`. A non-owner gets
 *     zero rows and therefore a 404 — never a 403, which would confirm the order
 *     exists and let an attacker enumerate order numbers (they are sequential).
 *
 *  3. MONEY STATE CHANGES ONLY ON CONFIRMATION. An order becomes PAID via
 *     `markPaid` (webhook-driven) and REFUNDED via `settleRefund`
 *     (webhook-driven). The operator-facing endpoints record intent; they never
 *     assert that money moved.
 */

const ORDER_DETAIL_INCLUDE = {
  items: true,
  events: { orderBy: { createdAt: "asc" } },
  // Oldest parcel first — the order a customer and the shipment card read them.
  shipments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.OrderInclude;

const SUMMARY_INCLUDE = {
  items: { select: { quantity: true } },
} satisfies Prisma.OrderInclude;

/** Per-locale JSON blobs (`variant.name`) parsed rather than cast. */
const localisedTextSchema = z.record(z.string(), z.unknown());

function readLocalised(value: unknown, locale: Locale): string | null {
  const parsed = localisedTextSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const text = parsed.data[locale];
  return typeof text === "string" && text.length > 0 ? text : null;
}

/**
 * Narrow the result of a `$queryRaw` down to one text column.
 *
 * `$queryRaw` hands back `unknown`, and the usual response is a cast to the
 * expected row shape. That cast is a lie the compiler cannot check: a renamed
 * SQL alias produces `undefined` at runtime with a `string` static type, and the
 * order number silently becomes the literal "undefined".
 */
const textRowsSchema = z.array(z.object({ value: z.string().min(1) })).min(1);

function readSingleText(rows: unknown, what: string): string {
  const parsed = textRowsSchema.safeParse(rows);
  if (!parsed.success) {
    throw new ConflictException(
      `Failed to allocate ${what}: the sequence function returned an unexpected shape.`,
    );
  }
  // `.min(1)` above guarantees the element exists; read it without a non-null
  // assertion so noUncheckedIndexedAccess stays honest.
  const [first] = parsed.data;
  if (first === undefined) {
    throw new ConflictException(`Failed to allocate ${what}.`);
  }
  return first.value;
}

/**
 * Server-internal input for order creation. Never bound directly to a request
 * body.
 *
 * DELIBERATELY UNCHANGED from the original shape so any caller (CheckoutModule)
 * needs no new fields. Everything order creation adds — the DESTINATION tax rate,
 * the applied DISCOUNT, and the stock RESERVATIONS to link — is derived here from
 * the cart itself (its ship-to address, its `discountCode`, and the reservations
 * already opened against its `cartId`), never passed in. That keeps the "no client
 * amounts" boundary intact and means the checkout orchestrator only supplies
 * identity, addresses and the server-resolved shipping charge.
 */
export interface CreateOrderFromCartInput {
  readonly cartId: string;
  /** Null for guest checkout; the order is claimable later by verifying `email`. */
  readonly customerId: string | null;
  readonly email: string;
  readonly locale: Locale;
  readonly shippingAddress: AddressFields;
  readonly billingAddress: AddressFields;
  /** Resolved server-side from a ShippingRate row. Never from the client. */
  readonly shipping: ShippingCharge;
  readonly shippingMethodName: string;
  readonly acceptedTermsVersion: string;
  readonly vatNumber: string | null;
  /**
   * The fulfilment snapshot checkout resolved and VERIFIED (Sendcloud spec
   * §3.3/§3.4): the chosen rate, its option code, the parcel weight, the
   * separate house number and — for a pickup rate — the re-verified point.
   * Frozen onto the order so a later rate remap, product purge or point
   * closure cannot change how an already-paid order ships. Optional only so
   * callers that pre-date it keep compiling; checkout always sends it.
   */
  readonly fulfilment?: OrderFulfilmentSnapshot | undefined;
}

/** Column-for-column the `Order` fulfilment snapshot (migration 20260925120000). */
export interface OrderFulfilmentSnapshot {
  readonly shippingRateId: string;
  readonly sendcloudOptionCode: string | null;
  readonly parcelWeightGrams: number;
  readonly shipHouseNumber: string | null;
  readonly servicePointId: string | null;
  readonly servicePointCarrierId: string | null;
  readonly servicePointName: string | null;
  readonly servicePointAddress: string | null;
  readonly servicePointPostNumber: string | null;
}

export interface MarkPaidInput {
  readonly orderId: string;
  readonly providerCheckoutToken?: string;
  readonly paidAt?: Date;
}

export interface SettleRefundInput {
  readonly refundId: string;
  readonly providerRefundId?: string;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DESTINATION_TAX_RESOLVER)
    private readonly destinationTax: DestinationTaxResolverPort,
    private readonly inventory: ProductInventoryService,
    private readonly discounts: DiscountsService,
    // Customer mail carries a link back to the order, which is a dashboard URL.
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
  ) {}

  /** The customer-facing order page. Trailing slash trimmed so no `//` appears. */
  private customerOrderUrl(orderNumber: string): string {
    return `${this.config.DASHBOARD_URL.replace(/\/+$/, "")}/orders/${orderNumber}`;
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Turn a cart into an immutable order.
   *
   * Every display field is COPIED onto the order line rather than referenced.
   * Rendering a two-year-old order must never join to the live product table: a
   * renamed product or a repriced variant would retroactively rewrite an invoice
   * that has already been filed for tax, and the customer's PDF would stop
   * matching their bank statement.
   */
  async createFromCart(input: CreateOrderFromCartInput): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      const cart = assertFound(
        await tx.cart.findUnique({
          where: { id: input.cartId },
          include: {
            items: {
              orderBy: { createdAt: "asc" },
              include: {
                variant: {
                  include: {
                    product: {
                      include: {
                        translations: true,
                        media: { orderBy: { sortOrder: "asc" }, take: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        "Cart",
      );

      // A cart already bound to a customer may only be checked out by that
      // customer. RecordNotFoundError, not Forbidden: the cart id is a bearer
      // handle, and confirming that someone else's id is valid is itself a leak.
      if (cart.customerId !== null && cart.customerId !== input.customerId) {
        throw new RecordNotFoundError("Cart");
      }

      if (cart.items.length === 0) {
        throw new UnprocessableEntityException("Cannot place an order from an empty cart.");
      }

      // DESTINATION VAT. Resolve the ship-to country's rate for each distinct tax
      // class ONCE and reuse it. This replaces the origin rate baked onto the
      // variant (`variant.taxRateBps`): an order shipped to Germany must be charged
      // German VAT for the product's class, not the store's Spanish rate (issue
      // SEV3). The lookup is keyed (destination country, tax class) exactly as the
      // tax_rate table is.
      const taxRateByClass = new Map<TaxClass, number>();
      const resolveTaxBps = async (taxClass: TaxClass): Promise<number> => {
        const cached = taxRateByClass.get(taxClass);
        if (cached !== undefined) {
          return cached;
        }
        const bps = await this.destinationTax.resolveBps(
          input.shippingAddress.countryCode,
          taxClass,
        );
        taxRateByClass.set(taxClass, bps);
        return bps;
      };

      // PACK PRICING, RESOLVED FIRST. A pack-tagged cart item's charged price
      // is NOT its own `variant.priceGross` — it is that component's pro-rata
      // SHARE of the pack's flat price, computed by the exact same
      // `allocatePackComponents` the cart's own live preview uses (see that
      // function's doc comment for why one function has to serve both call
      // sites). Resolved once, per pack instance, before the main per-item
      // loop below reads from it. The recipe (which variant, and its own
      // quantity) is fetched FRESH here too, never trusted from the cart's
      // stored rows — an admin may have edited it since the item was added,
      // and a stale recipe would silently mis-weight the allocation.
      const packProductIds = [
        ...new Set(
          cart.items
            .map((item) => item.packProductId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const packs =
        packProductIds.length === 0
          ? []
          : await tx.product.findMany({
              where: { id: { in: packProductIds }, kind: "PACK", deletedAt: null },
              include: {
                variants: { where: { deletedAt: null }, take: 1 },
                packComponents: {
                  where: { component: { deletedAt: null } },
                  orderBy: { sortOrder: "asc" },
                  select: { componentVariantId: true, quantity: true },
                },
              },
            });
      const packPriceByProductId = new Map<string, Minor>(
        packs.flatMap((pack) => {
          const variant = pack.variants[0];
          return variant === undefined ? [] : [[pack.id, toMinor(variant.priceGross)] as const];
        }),
      );
      const packRecipeByProductId = new Map(
        packs.map((pack) => [
          pack.id,
          pack.packComponents.map((component) => ({
            variantId: component.componentVariantId,
            quantity: component.quantity,
          })),
        ]),
      );

      const packInstanceGroups = new Map<string, typeof cart.items>();
      for (const item of cart.items) {
        if (item.packInstanceId === null) {
          continue;
        }
        const group = packInstanceGroups.get(item.packInstanceId) ?? [];
        group.push(item);
        packInstanceGroups.set(item.packInstanceId, group);
      }

      // Two passes. First build every priced line (re-priced from the LIVE variant,
      // taxed by destination); then push the order-level discount down onto the
      // lines with the remainder-distributing allocator, so the per-line discounts
      // sum EXACTLY to the order discount and no cent is lost on the invoice.
      const drafts: { line: PricedLine; grossAmount: Minor }[] = [];

      const draftLine = async (
        variant: (typeof cart.items)[number]["variant"],
        quantity: number,
        unitPriceGross: Minor,
        packProductId: string | null,
        packInstanceId: string | null,
      ): Promise<void> => {
        if (!variant.isActive || variant.deletedAt !== null) {
          throw new ConflictException(
            `${variant.sku} is no longer available and cannot be ordered.`,
          );
        }
        if (variant.currency !== cart.currency) {
          throw new ConflictException(
            `${variant.sku} is priced in ${variant.currency} but the cart is in ` +
              `${cart.currency}. Mixed-currency orders are not supported.`,
          );
        }

        const translation =
          variant.product.translations.find((row) => row.locale === input.locale) ??
          variant.product.translations[0];
        const [image] = variant.product.media;

        drafts.push({
          line: {
            variantId: variant.id,
            // Falling back to the slug rather than an empty string: a line with no
            // name is unreadable on an invoice, and the slug is always present.
            productName: translation?.name ?? variant.product.slug,
            variantName: readLocalised(variant.name, input.locale),
            sku: variant.sku,
            imageUrl: image?.url ?? null,
            quantity,
            unitPriceGross,
            taxRateBps: await resolveTaxBps(variant.product.taxClass),
            lineDiscount: ZERO,
            packProductId,
            packInstanceId,
          },
          grossAmount: multiply(unitPriceGross, quantity),
        });
      };

      // STANDALONE LINES — one draft per cart item, exactly as before.
      for (const item of cart.items) {
        if (item.packInstanceId !== null) {
          continue;
        }
        // THE RE-PRICE. `item.unitPriceGross` is the snapshot taken when the
        // line was added to the cart and is deliberately ignored here: an
        // order must charge the live price or refuse, never the stale one.
        await draftLine(item.variant, item.quantity, toMinor(item.variant.priceGross), null, null);
      }

      // PACK LINES — regrouped by (packInstanceId, variantId) first, since a
      // component with quantity > 1 can already be split across up to two
      // stored cart rows (`pack-pricing.ts`) — "one stored row = one
      // component" no longer holds. One or two order lines are drafted per
      // component, matching however the fresh allocation splits it, never
      // 1:1 with whatever happened to be stored.
      for (const [, group] of packInstanceGroups) {
        const packProductId = group[0]?.packProductId ?? null;
        const packPrice = packProductId === null ? undefined : packPriceByProductId.get(packProductId);
        const recipe = packProductId === null ? undefined : packRecipeByProductId.get(packProductId);
        if (packPrice === undefined || recipe === undefined || recipe.length === 0) {
          throw new ConflictException(
            "A pack in this cart is no longer available and cannot be ordered.",
          );
        }

        const referenceVariantByVariantId = new Map(group.map((item) => [item.variantId, item.variant]));
        const storedQuantityByVariantId = new Map<string, number>();
        for (const item of group) {
          storedQuantityByVariantId.set(
            item.variantId,
            (storedQuantityByVariantId.get(item.variantId) ?? 0) + item.quantity,
          );
        }

        // RECIPE DRIFT GUARD. If the pack's recipe changed since this cart's
        // items were added — a component removed, or none of the stored
        // variants match the current recipe at all — refuse rather than
        // charge against a recipe the cart never actually agreed to. This is
        // the same "no longer available" refusal a vanished pack already
        // gets, extended to a pack that is still around but different.
        let packQuantity = 0;
        for (const component of recipe) {
          const stored = storedQuantityByVariantId.get(component.variantId) ?? 0;
          if (stored > 0) {
            packQuantity = Math.floor(stored / component.quantity);
            break;
          }
        }
        if (packQuantity === 0 || !recipe.every((component) => referenceVariantByVariantId.has(component.variantId))) {
          throw new ConflictException(
            "A pack in this cart has changed since it was added and cannot be ordered as-is. Please remove and re-add it.",
          );
        }

        // ALLOCATED AT THE SINGLE-PACK BASIS, packQuantity applied after —
        // same reasoning `pack-pricing.ts`/`CartService.addPack` give.
        const allocated = allocatePackComponents(
          packPrice,
          recipe.map((component) => {
            const variant = referenceVariantByVariantId.get(component.variantId);
            return {
              lineId: component.variantId,
              // SAME PRICE BASIS the rest of this function already uses for
              // every line — this function never resolves volume tiers here
              // (see the surrounding lines' own `toMinor(variant.priceGross)`),
              // so the pack allocation ratio must not introduce a different
              // basis for its components alone.
              liveUnitPrice: variant === undefined ? toMinor(0) : toMinor(variant.priceGross),
              quantity: component.quantity,
            };
          }),
        );

        const packInstanceId = group[0]?.packInstanceId ?? null;
        for (const share of allocated) {
          const variant = referenceVariantByVariantId.get(share.lineId);
          if (variant === undefined) {
            continue;
          }
          await draftLine(
            variant,
            share.quantity * packQuantity,
            share.unitPriceGross,
            packProductId,
            packInstanceId,
          );
        }
      }

      const grossSubtotal = sum(drafts.map((draft) => draft.grossAmount));

      // Apply the cart's discount code, re-validated against the FRESHLY re-priced
      // subtotal (the code was validated once for the cart, but prices can move in
      // between). A code that has since expired or hit its cap degrades to no
      // discount — the same policy the cart uses — rather than blocking the order.
      const validatedDiscount = await this.resolveCartDiscount(
        cart.discountCode,
        grossSubtotal,
        cart.currency,
        input.customerId,
      );
      const appliedDiscount = applyDiscountToLines(
        drafts,
        validatedDiscount === null ? null : validatedDiscount.amount,
        grossSubtotal,
      );

      const lines: PricedLine[] = drafts.map((draft) => draft.line);
      const priced = priceOrder(lines, input.shipping);

      const orderNumber = readSingleText(
        await tx.$queryRaw`SELECT next_order_number() AS "value"`,
        "an order number",
      );

      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: input.customerId,
          email: input.email,
          status: "PENDING",
          locale: input.locale,
          currency: cart.currency,

          subtotal: priced.totals.subtotal,
          discountTotal: priced.totals.discountTotal,
          shippingTotal: priced.totals.shippingTotal,
          taxTotal: priced.totals.taxTotal,
          grandTotal: priced.totals.grandTotal,

          ...shippingColumns(input.shippingAddress),
          ...billingColumns(input.billingAddress),

          vatNumber: input.vatNumber,
          shippingMethodName: input.shippingMethodName,
          acceptedTermsVersion: input.acceptedTermsVersion,
          ...(input.fulfilment === undefined ? {} : fulfilmentColumns(input.fulfilment)),

          items: { create: priced.lines.map((line) => ({ ...line })) },
          events: {
            create: [
              {
                type: "ORDER_PLACED",
                message: `Order ${orderNumber} placed.`,
                isInternal: false,
              },
            ],
          },
        },
        include: ORDER_DETAIL_INCLUDE,
      });

      // Link the stock reservations opened at checkout (they carry this cartId) to
      // the order, so the sale-completed path (markPaid ->
      // commitReservationsForOrder) can decrement on-hand and write a SALE ledger
      // row against it. Linking by cartId — rather than requiring the caller to
      // hand back reservation ids — keeps order creation caller-agnostic: any path
      // that reserved against this cart gets its holds bound automatically.
      await tx.stockReservation.updateMany({
        where: { cartId: input.cartId, releasedAt: null, orderId: null },
        data: { orderId: created.id },
      });

      // Consume ONE redemption of the discount, in the SAME transaction as the
      // order. A redemption recorded for an order that later rolled back would
      // burn a single-use code for a sale that never happened; committing them
      // together is what stops that.
      if (validatedDiscount !== null && appliedDiscount > 0) {
        await recordDiscountRedemption(tx, {
          discountId: validatedDiscount.discountId,
          orderId: created.id,
          customerId: input.customerId,
          amountApplied: appliedDiscount,
        });
      }

      return toOrderDto(created, "customer");
    });
  }

  /**
   * Re-validate the cart's discount code against the freshly re-priced subtotal.
   *
   * Returns the validated discount, or null when there is no code or the code is
   * no longer usable. A DiscountError (expired, at cap, below minimum, wrong
   * currency) degrades to null — the order proceeds at full price, matching what
   * the cart already displays once a code lapses. Any other error is a genuine
   * fault and propagates.
   */
  private async resolveCartDiscount(
    code: string | null,
    subtotalGross: Minor,
    currency: CurrencyCode,
    customerId: string | null,
  ): Promise<ValidatedDiscount | null> {
    if (code === null) {
      return null;
    }
    try {
      return await this.discounts.validate({ code, subtotalGross, currency, customerId });
    } catch (error) {
      if (error instanceof DiscountError) {
        return null;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Customer reads
  // -------------------------------------------------------------------------

  async listForCustomer(
    customerId: string,
    query: CustomerOrderListQuery,
  ): Promise<Paginated<OrderSummary>> {
    const rows = await this.prisma.order.findMany({
      where: { customerId },
      include: SUMMARY_INCLUDE,
      // Two keys, not one. `placedAt` alone is not unique, and a cursor over a
      // non-unique sort silently skips or repeats rows when two orders land in
      // the same millisecond — which is exactly what a load test produces.
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
    });

    return paginate(rows, query.limit, toOrderSummaryDto);
  }

  /** Ownership-scoped detail read. A non-owner gets 404, never 403. */
  async getForCustomer(customerId: string, orderNumber: string): Promise<Order> {
    const row = await this.prisma.order.findFirst({
      where: ownedByOrderNumber(orderNumber, customerId),
      include: ORDER_DETAIL_INCLUDE,
    });

    return toOrderDto(assertFound(row, "Order"), "customer");
  }

  /**
   * Backs the post-checkout "processing" screen.
   *
   * The browser returning from the hosted payment page polls this rather than
   * asserting success,
   * because an order becomes PAID only via a signature-verified webhook. A
   * client-side success redirect is forged in ten seconds.
   */
  async getStatusForCustomer(
    customerId: string,
    orderNumber: string,
  ): Promise<{
    orderNumber: string;
    status: Order["status"];
    isPaid: boolean;
    isTerminal: boolean;
  }> {
    const row = assertFound(
      await this.prisma.order.findFirst({
        where: ownedByOrderNumber(orderNumber, customerId),
        select: { orderNumber: true, status: true },
      }),
      "Order",
    );

    return {
      orderNumber: row.orderNumber,
      status: row.status,
      isPaid: isPaidStatus(row.status),
      isTerminal: isTerminal(row.status),
    };
  }

  // -------------------------------------------------------------------------
  // Admin reads
  // -------------------------------------------------------------------------

  async listForAdmin(query: AdminOrderListQuery): Promise<Paginated<AdminOrderSummary>> {
    const rows = await this.prisma.order.findMany({
      where: {
        // AND-composed: the shipping filter carries its own `status` / `OR`
        // clauses, and spreading it beside the status filter would let one
        // silently overwrite the other.
        AND: [
          query.status === undefined ? {} : { status: query.status },
          query.email === undefined ? {} : { email: query.email },
          query.orderNumber === undefined
            ? {}
            : { orderNumber: { contains: query.orderNumber } },
          query.shipping === undefined ? {} : shippingFilterWhere(query.shipping),
        ],
      },
      include: ADMIN_SUMMARY_INCLUDE,
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
    });

    return paginate(rows, query.limit, toAdminOrderSummaryDto);
  }

  /** Admin detail read — deliberately unscoped, and it includes internal events. */
  async getForAdmin(orderNumber: string): Promise<AdminOrder> {
    const row = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: ORDER_DETAIL_INCLUDE,
    });

    return toAdminOrderDto(assertFound(row, "Order"));
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * Operator-driven status change.
   *
   * Two gates, in this order and for different reasons:
   *  - `assertAdminMayAssign` refuses statuses that belong to a system event
   *    (PAID above all). This is a 403: the transition may be perfectly legal,
   *    but not for a human.
   *  - `assertTransition` refuses moves the state machine does not permit. This
   *    is a 409.
   */
  async transitionByAdmin(
    orderNumber: string,
    body: AdminTransitionOrder,
    actor: Principal,
  ): Promise<AdminOrder> {
    assertAdminMayAssign(body.status);

    return this.prisma.$transaction(async (tx) => {
      const order = assertFound(
        await tx.order.findUnique({ where: { orderNumber } }),
        "Order",
      );

      assertTransition(order.status, body.status);

      await applyStatus(tx, {
        id: order.id,
        expectedStatus: order.status,
        expectedVersion: order.version,
        nextStatus: body.status,
      });

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "STATUS_CHANGED",
          message:
            `Status changed ${order.status} -> ${body.status}` +
            (body.note === undefined ? "." : `: ${body.note}`),
          // Operator actions are internal by default. "Status changed by
          // operator #4b2f" is not something a customer should read, and the
          // customer-facing signal is the shipping/refund email instead.
          isInternal: true,
          actorId: actor.customerId,
        },
      });

      // A cancellation is the ONE operator transition the customer must hear
      // about, and it needs a reason line the customer can read.
      //
      // The reason the mail renders comes from a `payment.canceled` OrderEvent —
      // and NOTHING in the platform ever wrote one, so every cancellation mail
      // would have fallen back to a contentless generic string. This writes it.
      //
      // Deliberately NOT `body.note`: that is written for a colleague
      // ("suspected reseller", "duplicate of AK-2026-000118") and it is exactly
      // why the STATUS_CHANGED event above is internal. A second, customer-safe
      // event is the honest way to have both.
      if (body.status === "CANCELLED") {
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "payment.canceled",
            message: cancellationReason(order.locale),
            isInternal: false,
            actorId: actor.customerId,
          },
        });

        await tx.outboxMessage.create({
          data: {
            topic: "email",
            payload: {
              templateKey: "order-cancelled",
              orderId: order.id,
              orderNumber: order.orderNumber,
              locale: order.locale,
              recipient: order.email,
            },
          },
        });
      }

      return this.reloadForAdmin(tx, order.id);
    });
  }

  /**
   * The ONLY path to PAID. Called by the Whop webhook handler, never by a
   * controller.
   *
   * Idempotent by design: providers retry webhooks aggressively and deliver
   * events out of order, so a second `payment/succeeded` (or `order/paid`) for
   * an order that is already PAID (or already SHIPPED) must be a no-op returning
   * the current state, not a 409 that makes the provider retry forever.
   */
  async markPaid(input: MarkPaidInput): Promise<Order> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const order = assertFound(
        await tx.order.findUnique({ where: { id: input.orderId } }),
        "Order",
      );

      if (isPaidStatus(order.status)) {
        return { order: await this.reloadForAdmin(tx, order.id), transitioned: false };
      }

      // A webhook can land while the order is still PENDING (the customer paid
      // before our checkout-session bookkeeping committed). We WALK the machine
      // rather than jumping: PENDING -> AWAITING_PAYMENT -> PAID are both legal
      // edges, so no rule is bent and the timeline stays truthful.
      let current = order.status;
      let version = order.version;

      if (current === "PENDING") {
        assertTransition(current, "AWAITING_PAYMENT");
        await applyStatus(tx, {
          id: order.id,
          expectedStatus: current,
          expectedVersion: version,
          nextStatus: "AWAITING_PAYMENT",
        });
        current = "AWAITING_PAYMENT";
        version += 1;
      }

      assertTransition(current, "PAID");

      // The invoice number is allocated HERE and nowhere else. Gap-free
      // numbering is a legal requirement, so an abandoned cart or a failed
      // payment must never consume one — which is why allocation hangs off the
      // PAID transition rather than off order creation.
      const invoiceNumber = readSingleText(
        await tx.$queryRaw`SELECT next_invoice_number() AS "value"`,
        "an invoice number",
      );

      await applyStatus(tx, {
        id: order.id,
        expectedStatus: current,
        expectedVersion: version,
        nextStatus: "PAID",
        extra: {
          paidAt: input.paidAt ?? new Date(),
          invoiceNumber,
          ...(input.providerCheckoutToken === undefined
            ? {}
            : { providerCheckoutToken: input.providerCheckoutToken }),
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "PAYMENT_RECEIVED",
          message: `Payment confirmed. Invoice ${invoiceNumber} issued.`,
          isInternal: false,
        },
      });

      return { order: await this.reloadForAdmin(tx, order.id), transitioned: true };
    });

    // The sale is now confirmed, so the stock held at checkout becomes a real
    // decrement and a SALE ledger row (issue SEV2 — reserve/commit existed but no
    // path called them). Done ONLY on an actual transition, never on the
    // idempotent re-delivery of an already-paid order, and AFTER the transaction
    // so the commit runs in its own transaction rather than nesting. The commit
    // is idempotent, so a retried settlement is safe.
    if (outcome.transitioned) {
      await this.inventory.commitReservationsForOrder(input.orderId);
    }

    return outcome.order;
  }

  // -------------------------------------------------------------------------
  // Shipments
  // -------------------------------------------------------------------------

  /**
   * Record a parcel covering a subset of the order's lines.
   *
   * The over-shipment check is the important part. Without it, two operators
   * working the same order each create a shipment for the full quantity, the
   * customer is told twice that everything is on its way, and the inventory
   * ledger records twice as much stock leaving as actually did.
   */
  async createShipment(
    orderNumber: string,
    body: CreateShipmentRequest,
    actor: Principal,
  ): Promise<Shipment> {
    return this.prisma.$transaction(async (tx) => {
      const order = assertFound(
        await tx.order.findUnique({
          where: { orderNumber },
          include: { items: true, shipments: { include: { items: true } } },
        }),
        "Order",
      );

      if (!isPaidStatus(order.status)) {
        throw new ConflictException(
          `Order ${orderNumber} is ${order.status}; nothing may ship before payment is confirmed.`,
        );
      }

      const orderItemById = new Map(order.items.map((item) => [item.id, item]));
      const orderedByItemId = new Map(order.items.map((item) => [item.id, item.quantity]));
      const shippedByItemId = new Map<string, number>();
      for (const shipment of order.shipments) {
        // A cancelled label or a refused announcement moved nothing; counting
        // its lines as shipped would block the replacement parcel.
        if (!carriesGoods(shipment.status)) {
          continue;
        }
        for (const line of shipment.items) {
          shippedByItemId.set(
            line.orderItemId,
            (shippedByItemId.get(line.orderItemId) ?? 0) + line.quantity,
          );
        }
      }

      const seen = new Set<string>();
      for (const line of body.items) {
        if (seen.has(line.orderItemId)) {
          throw new UnprocessableEntityException(
            `Order item ${line.orderItemId} appears twice in one shipment.`,
          );
        }
        seen.add(line.orderItemId);

        const ordered = orderedByItemId.get(line.orderItemId);
        if (ordered === undefined) {
          // 404-shaped, not 422: the item may well exist on a DIFFERENT order,
          // and confirming that would leak the existence of another customer's
          // line to anyone who can reach this endpoint.
          throw new RecordNotFoundError("Order item");
        }

        const remaining = ordered - (shippedByItemId.get(line.orderItemId) ?? 0);
        if (line.quantity > remaining) {
          throw new ConflictException(
            `Order item ${line.orderItemId} has only ${remaining} unit(s) left to ship; ` +
              `${line.quantity} requested.`,
          );
        }
      }

      const shipment = await tx.shipment.create({
        data: {
          orderId: order.id,
          status: "IN_TRANSIT",
          carrier: body.carrier,
          trackingNumber: body.trackingNumber,
          shippedAt: new Date(),
          items: { create: body.items.map((line) => ({ ...line })) },
        },
        include: { items: true },
      });

      // Walk the order forward: PAID -> FULFILLING on the first parcel, then
      // -> SHIPPED once nothing is left unshipped.
      let current = order.status;
      let version = order.version;

      if (current === "PAID") {
        assertTransition(current, "FULFILLING");
        await applyStatus(tx, {
          id: order.id,
          expectedStatus: current,
          expectedVersion: version,
          nextStatus: "FULFILLING",
        });
        current = "FULFILLING";
        version += 1;
      }

      for (const line of body.items) {
        shippedByItemId.set(
          line.orderItemId,
          (shippedByItemId.get(line.orderItemId) ?? 0) + line.quantity,
        );
      }
      const fullyShipped = order.items.every(
        (item) => (shippedByItemId.get(item.id) ?? 0) >= item.quantity,
      );

      if (fullyShipped && current === "FULFILLING") {
        assertTransition(current, "SHIPPED");
        await applyStatus(tx, {
          id: order.id,
          expectedStatus: current,
          expectedVersion: version,
          nextStatus: "SHIPPED",
        });
      }

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "SHIPMENT_CREATED",
          message:
            `Shipped via ${body.carrier}` +
            (body.trackingNumber === null ? "." : ` (tracking ${body.trackingNumber}).`),
          isInternal: false,
          actorId: actor.customerId,
        },
      });

      // ONE MAIL PER PARCEL, enqueued in the SAME transaction as the shipment.
      //
      // HYDRATED, not a reference: an order reference names an order, and an
      // order can hold several parcels, so nothing downstream could tell WHICH
      // one a reference row meant. The payload is also the honest snapshot —
      // "these items left the building today" is a fact about this moment, and
      // a later edit to the shipment must not rewrite a mail already sent.
      //
      // `dedupeScope` is the shipment id. Without it the claim collides with
      // parcel one's, `send` reports `duplicate`, the handler counts that as
      // terminal success, and the customer is never told about parcel two.
      await tx.outboxMessage.create({
        data: {
          topic: "email",
          payload: {
            templateKey: "shipping-confirmation",
            to: order.email,
            locale: order.locale,
            orderId: order.id,
            dedupeScope: shipment.id,
            payload: {
              // The ship-to name, not the account holder's: it is who the
              // parcel is addressed to, and it is always present on the order.
              firstName: order.shipFirstName,
              orderNumber: order.orderNumber,
              carrier: shipment.carrier,
              // OMITTED rather than null when absent — the payload schema makes
              // both optional so an untracked parcel still mails. A null would
              // fail `.strict()` and dead-letter the mail instead.
              //
              // EMPTY IS ABSENT TOO. The DTO is `z.string().max(128).nullable()`
              // with no `.min(1)`, so "" and "   " reach this column, while the
              // payload requires `.min(1)` — a `=== null` test alone therefore
              // forwards a blank number, the payload is rejected, and the mail
              // dead-letters. That is precisely the silent failure the optional
              // fields were introduced to remove, and it strikes the parcels
              // whose tracking was fumbled at entry.
              ...(shipment.trackingNumber === null || shipment.trackingNumber.trim() === ""
                ? {}
                : { trackingNumber: shipment.trackingNumber.trim() }),
              ...(shipment.trackingUrl === null
                ? {}
                : { trackingUrl: shipment.trackingUrl }),
              shippedAt: (shipment.shippedAt ?? new Date()).toISOString(),
              orderUrl: this.customerOrderUrl(order.orderNumber),
              lines: body.items.map((line) => {
                const item = orderItemById.get(line.orderItemId);
                if (item === undefined) {
                  // Unreachable: the loop above rejects an unknown item id.
                  // Narrowed rather than silenced with `!`, so a future
                  // reordering of these blocks fails loudly instead of
                  // mailing a line with `undefined` in it.
                  throw new RecordNotFoundError("Order item");
                }
                return {
                  name: item.productName,
                  ...(item.variantName === null
                    ? {}
                    : { variantName: item.variantName }),
                  quantity: line.quantity,
                  unitPrice: { amount: item.unitPriceGross, currency: order.currency },
                  // Priced by what is IN THIS PARCEL. Quoting the order line
                  // total on a partial shipment tells the customer the whole
                  // order is on its way when half of it is still on a shelf.
                  lineTotal: {
                    amount: multiply(toMinor(item.unitPriceGross), line.quantity),
                    currency: order.currency,
                  },
                };
              }),
            },
          },
        },
      });

      return toShipmentDto(shipment);
    });
  }

  /**
   * Mark a parcel delivered; move the order to DELIVERED once all parcels are.
   *
   * `actor` is null when no person did it: the Sendcloud tracking sync
   * (fulfilment/tracking) calls this when the carrier reports DELIVERED /
   * COLLECTED_BY_CUSTOMER, so the automated and the manual path share one
   * transition and one `delivery-confirmation` producer.
   */
  async markShipmentDelivered(shipmentId: string, actor: Principal | null): Promise<Shipment> {
    return this.prisma.$transaction(async (tx) => {
      const shipment = assertFound(
        await tx.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: true },
        }),
        "Shipment",
      );

      if (shipment.status === "DELIVERED") {
        return toShipmentDto(shipment);
      }

      const updated = await tx.shipment.update({
        where: { id: shipment.id },
        data: { status: "DELIVERED", deliveredAt: new Date() },
        include: { items: true },
      });

      const order = assertFound(
        await tx.order.findUnique({
          where: { id: shipment.orderId },
          include: { shipments: { select: { status: true } } },
        }),
        "Order",
      );

      // Over the parcels that actually carry goods: a cancelled label or a
      // FAILED announcement beside the delivered parcel must not hold the order
      // short of DELIVERED forever.
      const allDelivered = order.shipments
        .filter((row) => carriesGoods(row.status))
        .every((row) => row.status === "DELIVERED");

      if (allDelivered && order.status === "SHIPPED") {
        assertTransition(order.status, "DELIVERED");
        await applyStatus(tx, {
          id: order.id,
          expectedStatus: order.status,
          expectedVersion: order.version,
          nextStatus: "DELIVERED",
        });

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "ORDER_DELIVERED",
            message: "All parcels delivered.",
            isInternal: false,
            actorId: actor?.customerId ?? null,
          },
        });

        // A REFERENCE row, unlike the shipping mail: the delivery payload is
        // only a timestamp and a link, both derivable from the live order, so
        // there is nothing to freeze into the queue. Enqueued only inside this
        // branch — "your order was delivered" while another parcel is still on
        // a van is worse than silence, because the customer stops watching.
        await tx.outboxMessage.create({
          data: {
            topic: "email",
            payload: {
              templateKey: "delivery-confirmation",
              orderId: order.id,
              orderNumber: order.orderNumber,
              locale: order.locale,
              recipient: order.email,
            },
          },
        });
      }

      return toShipmentDto(updated);
    });
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * Record an INTENT to refund. Deliberately does not touch `refundedTotal` or
   * the order status — see the DTO comment. The actual gateway call belongs to
   * RefundsModule, driven off this row through the outbox.
   */
  async requestRefund(
    orderNumber: string,
    body: CreateRefundRequest,
    actor: Principal,
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const order = assertFound(
        await tx.order.findUnique({
          where: { orderNumber },
          include: {
            payments: { where: { status: "SUCCEEDED" }, orderBy: { createdAt: "desc" } },
            refunds: { where: { status: "PENDING" } },
          },
        }),
        "Order",
      );

      if (!isPaidStatus(order.status)) {
        throw new ConflictException(
          `Order ${orderNumber} is ${order.status}; there is nothing to refund.`,
        );
      }

      const [payment] = order.payments;
      if (payment === undefined) {
        throw new ConflictException(
          `Order ${orderNumber} has no settled payment to refund against.`,
        );
      }

      // Pending refunds count against the balance. If they did not, two
      // operators clicking "refund" in the same minute would each pass an
      // independent check and together refund more than was ever paid.
      const pendingTotal = order.refunds.reduce((total, row) => total + row.amount, 0);
      const remaining = refundableRemaining(
        toMinor(order.grandTotal),
        toMinor(order.refundedTotal),
        toMinor(pendingTotal),
      );

      if (remaining <= 0) {
        throw new ConflictException(
          `Order ${orderNumber} has no refundable balance remaining.`,
        );
      }

      const amount = body.amount ?? remaining;
      if (amount > remaining) {
        throw new ConflictException(
          `Refund of ${amount} exceeds the ${remaining} still refundable on ${orderNumber}.`,
        );
      }

      const refund = await tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: order.id,
          status: "PENDING",
          reason: body.reason,
          amount,
          currency: order.currency,
          note: body.note ?? null,
          actorId: actor.customerId,
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "REFUND_REQUESTED",
          message: `Refund of ${amount} ${order.currency} requested (${body.reason}).`,
          isInternal: true,
          actorId: actor.customerId,
        },
      });

      return toRefundDto(refund);
    });
  }

  /**
   * Settle a refund once the provider confirms the money moved. Webhook-driven,
   * never reachable from a controller.
   *
   * This is where `refundedTotal` moves and where the order reaches REFUNDED or
   * PARTIALLY_REFUNDED — derived from the amounts, never chosen by a caller,
   * which is what keeps the refund ledger and the order status from disagreeing.
   */
  async settleRefund(input: SettleRefundInput): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const refund = assertFound(
        await tx.refund.findUnique({ where: { id: input.refundId } }),
        "Refund",
      );

      // Idempotent: the provider will re-deliver this event.
      if (refund.status === "SUCCEEDED") {
        return toRefundDto(refund);
      }
      if (refund.status !== "PENDING") {
        throw new ConflictException(
          `Refund ${refund.id} is ${refund.status} and cannot be settled.`,
        );
      }

      const order = assertFound(
        await tx.order.findUnique({ where: { id: refund.orderId } }),
        "Order",
      );

      const refundedTotal = order.refundedTotal + refund.amount;
      if (refundedTotal > order.grandTotal) {
        throw new ConflictException(
          `Settling refund ${refund.id} would refund ${refundedTotal} against a ` +
            `${order.grandTotal} order.`,
        );
      }

      const settled = await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: "SUCCEEDED",
          completedAt: new Date(),
          ...(input.providerRefundId === undefined
            ? {}
            : { providerRefundId: input.providerRefundId }),
        },
      });

      const nextStatus = statusAfterRefund(refundedTotal, order.grandTotal);

      // A second partial refund leaves the order in PARTIALLY_REFUNDED, and
      // PARTIALLY_REFUNDED -> PARTIALLY_REFUNDED is not an edge in the table.
      // Skip the transition rather than widen the table: a self-edge would make
      // every other guard in the machine weaker to solve a bookkeeping detail.
      if (nextStatus === order.status) {
        await tx.order.update({
          where: { id: order.id },
          data: { refundedTotal, version: { increment: 1 } },
        });
      } else {
        assertTransition(order.status, nextStatus);
        await applyStatus(tx, {
          id: order.id,
          expectedStatus: order.status,
          expectedVersion: order.version,
          nextStatus,
          extra: { refundedTotal },
        });
      }

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "REFUND_SETTLED",
          message: `Refund of ${refund.amount} ${refund.currency} completed.`,
          isInternal: false,
        },
      });

      return toRefundDto(settled);
    });
  }

  // -------------------------------------------------------------------------

  private async reloadForAdmin(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<AdminOrder> {
    const row = assertFound(
      await tx.order.findUnique({ where: { id: orderId }, include: ORDER_DETAIL_INCLUDE }),
      "Order",
    );
    return toAdminOrderDto(row);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ApplyStatusInput {
  readonly id: string;
  readonly expectedStatus: Order["status"];
  readonly expectedVersion: number;
  readonly nextStatus: Order["status"];
  readonly extra?: Prisma.OrderUpdateManyMutationInput;
}

/**
 * Apply a status change under optimistic concurrency.
 *
 * `updateMany` with the expected status AND version in the WHERE clause, then a
 * zero-count check. Read-then-write would let two out-of-order provider webhooks
 * both read PAID and both apply their own next status, with the loser silently
 * overwriting the winner. Here the loser updates zero rows and gets a 409, which
 * makes the provider retry against fresh state.
 */
/**
 * The customer-facing cancellation line.
 *
 * Written in the ORDER's locale because that is the locale the cancellation
 * mail renders in and the locale the customer reads their timeline in.
 *
 * It says WHO cancelled and offers a way back, which is as specific as this
 * path can honestly be: `transitionByAdmin` is operator-driven, and the only
 * other thing it knows is `body.note`, which is internal by construction.
 */
function cancellationReason(locale: Locale): string {
  return locale === "es"
    ? "Cancelado por nuestro equipo. Si no lo esperabas, responde a este correo y lo revisamos."
    : "Cancelled by our team. If you were not expecting this, reply to this email and we will look into it.";
}

/**
 * EXPORTED for the fulfilment module's label service (PAID -> FULFILLING on a
 * bought label, FULFILLING -> PAID on a cancelled one), so every status write
 * in the platform still goes through this one optimistic-concurrency check
 * after `assertTransition` — never a second hand-rolled `updateMany`.
 */
export async function applyStatus(
  tx: Prisma.TransactionClient,
  input: ApplyStatusInput,
): Promise<void> {
  const result = await tx.order.updateMany({
    where: { id: input.id, status: input.expectedStatus, version: input.expectedVersion },
    data: {
      ...(input.extra ?? {}),
      status: input.nextStatus,
      version: { increment: 1 },
      ...(input.nextStatus === "CANCELLED" ? { cancelledAt: new Date() } : {}),
    },
  });

  if (result.count === 0) {
    throw new ConflictException(
      `Order ${input.id} changed while this update was in flight ` +
        `(expected ${input.expectedStatus} at version ${input.expectedVersion}). ` +
        `Re-read the order and retry.`,
    );
  }
}

/**
 * Flatten an address onto the snapshotted `ship*` / `bill*` columns.
 *
 * Written out twice rather than generated from a prefix template. A computed-key
 * version needs a cast to convince the compiler the keys match the Prisma input
 * type, and that cast would happily survive a column being renamed — the
 * addresses would then silently write as nulls. Spelling the keys out means a
 * renamed column is a compile error at the one place that cares.
 */
function fulfilmentColumns(
  snapshot: OrderFulfilmentSnapshot,
): Pick<
  Prisma.OrderUncheckedCreateInput,
  | "shippingRateId"
  | "sendcloudOptionCode"
  | "parcelWeightGrams"
  | "shipHouseNumber"
  | "servicePointId"
  | "servicePointCarrierId"
  | "servicePointName"
  | "servicePointAddress"
  | "servicePointPostNumber"
> {
  return {
    shippingRateId: snapshot.shippingRateId,
    sendcloudOptionCode: snapshot.sendcloudOptionCode,
    parcelWeightGrams: snapshot.parcelWeightGrams,
    shipHouseNumber: snapshot.shipHouseNumber,
    servicePointId: snapshot.servicePointId,
    servicePointCarrierId: snapshot.servicePointCarrierId,
    servicePointName: snapshot.servicePointName,
    servicePointAddress: snapshot.servicePointAddress,
    servicePointPostNumber: snapshot.servicePointPostNumber,
  };
}

function shippingColumns(
  address: AddressFields,
): Pick<
  Prisma.OrderUncheckedCreateInput,
  | "shipFirstName"
  | "shipLastName"
  | "shipCompany"
  | "shipLine1"
  | "shipLine2"
  | "shipCity"
  | "shipRegion"
  | "shipPostalCode"
  | "shipCountryCode"
  | "shipPhone"
> {
  return {
    shipFirstName: address.firstName,
    shipLastName: address.lastName,
    shipCompany: address.company,
    shipLine1: address.line1,
    shipLine2: address.line2,
    shipCity: address.city,
    shipRegion: address.region,
    shipPostalCode: address.postalCode,
    shipCountryCode: address.countryCode,
    shipPhone: address.phone,
  };
}

function billingColumns(
  address: AddressFields,
): Pick<
  Prisma.OrderUncheckedCreateInput,
  | "billFirstName"
  | "billLastName"
  | "billCompany"
  | "billLine1"
  | "billLine2"
  | "billCity"
  | "billRegion"
  | "billPostalCode"
  | "billCountryCode"
  | "billPhone"
> {
  return {
    billFirstName: address.firstName,
    billLastName: address.lastName,
    billCompany: address.company,
    billLine1: address.line1,
    billLine2: address.line2,
    billCity: address.city,
    billRegion: address.region,
    billPostalCode: address.postalCode,
    billCountryCode: address.countryCode,
    billPhone: address.phone,
  };
}

/** Cursor pagination envelope, shared by the customer and admin list endpoints. */
function paginate<TRow extends { id: string }, TOut>(
  rows: readonly TRow[],
  limit: number,
  map: (row: TRow) => TOut,
): Paginated<TOut> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(map),
    nextCursor: hasMore && last !== undefined ? last.id : null,
    hasMore,
  };
}

/**
 * Push an order-level gross discount down onto the priced lines, mutating each
 * draft's `lineDiscount`. Returns the gross discount actually applied.
 *
 * The discount is CLAMPED to the freshly re-priced subtotal before it is
 * distributed: the code was validated against the cart, but prices can move
 * between validation and order creation, and a discount larger than the basket
 * would drive a line negative (which `computeLine` refuses outright). Sharing it
 * with the remainder-distributing allocator — never naive proportional rounding
 * — keeps the per-line discounts summing EXACTLY to the order discount.
 */
function applyDiscountToLines(
  drafts: { line: PricedLine; grossAmount: Minor }[],
  discountAmountGross: Minor | null,
  grossSubtotal: Minor,
): Minor {
  if (discountAmountGross === null) {
    return ZERO;
  }

  const discountGross =
    discountAmountGross > grossSubtotal ? grossSubtotal : discountAmountGross;
  if (discountGross <= 0) {
    return ZERO;
  }

  const shares = allocate(
    discountGross,
    drafts.map((draft) => draft.grossAmount),
  );

  drafts.forEach((draft, index) => {
    const share = shares[index];
    // noUncheckedIndexedAccess: `allocate` returns one share per ratio, so this is
    // proven length-equal — narrowed rather than silenced with `!`.
    if (share !== undefined) {
      draft.line = { ...draft.line, lineDiscount: share };
    }
  });

  return discountGross;
}

/**
 * Consume one redemption of a discount inside the order-creation transaction.
 *
 * The row-level lock the increment takes serialises concurrent redeemers, so the
 * cap check sees the POST-increment count — a check-then-write would let two
 * orders both claim the last slot. The unique `(discountId, orderId)` index makes
 * a second redemption for the same order a database error rather than a
 * double-spend. Throwing rolls the whole order back, which is correct: a code
 * that is genuinely exhausted must not silently create an un-discounted order the
 * customer was told would be cheaper.
 */
async function recordDiscountRedemption(
  tx: Prisma.TransactionClient,
  input: {
    readonly discountId: string;
    readonly orderId: string;
    readonly customerId: string | null;
    readonly amountApplied: number;
  },
): Promise<void> {
  const updated = await tx.discount.update({
    where: { id: input.discountId },
    data: { timesRedeemed: { increment: 1 } },
    select: { timesRedeemed: true, maxRedemptions: true },
  });

  if (updated.maxRedemptions !== null && updated.timesRedeemed > updated.maxRedemptions) {
    throw new ConflictException("That discount code has reached its usage limit.");
  }

  await tx.discountRedemption.create({
    data: {
      discountId: input.discountId,
      orderId: input.orderId,
      customerId: input.customerId,
      amountApplied: input.amountApplied,
    },
  });
}
