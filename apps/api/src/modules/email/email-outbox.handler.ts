import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import {
  emailSchema,
  emailTemplateKeySchema,
  localeSchema,
  type EmailTemplateKey,
  type Locale,
} from "@akai/contracts";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import type { OutboxHandler, OutboxMessage } from "../outbox/outbox.types";
import type { EmailDispatchResult } from "./email.service";
import { EmailService } from "./email.service";

/**
 * A fully-hydrated email row: the producer already assembled the template
 * payload and knows the recipient. This is the shape the auth outbox writer
 * emits for `verify-email` / `reset-password`, where the link and the token are
 * only known at emit time.
 */
const hydratedEnvelopeSchema = z.object({
  templateKey: emailTemplateKeySchema,
  to: emailSchema,
  locale: localeSchema,
  payload: z.record(z.string(), z.unknown()),
  orderId: z.string().uuid().optional(),
  /**
   * Widens the idempotency claim within an order — see `email_event`. The
   * PRODUCER decides it, because only the producer knows what "one of these"
   * means: for `shipping-confirmation` it is the shipment id, so parcel two is
   * a distinct row instead of a swallowed duplicate.
   */
  dedupeScope: z.string().max(64).optional(),
});

/**
 * A reference-only email row: the producer named the template and the order but
 * left the payload to be assembled from the live order aggregate at send time.
 * This is what OrdersModule / the Whop webhook emit — deliberately, so a
 * confirmation reflects the order as it stands when the mail is actually sent,
 * not a snapshot frozen into the queue.
 *
 * `passthrough` because different templates attach different extra fields
 * (a refund row carries `amount`/`currency`); they are read explicitly below.
 */
const referenceEnvelopeSchema = z
  .object({
    templateKey: emailTemplateKeySchema,
    orderId: z.string().uuid(),
    locale: localeSchema.optional(),
    recipient: emailSchema.optional(),
    amount: z.number().int().optional(),
    currency: z.string().length(3).optional(),
  })
  .passthrough();

type ReferenceEnvelope = z.infer<typeof referenceEnvelopeSchema>;

interface HydratedEmail {
  readonly to: string;
  readonly locale: Locale;
  readonly data: Record<string, unknown>;
  readonly orderId: string;
}

/** Drop a trailing slash so `${base}/orders/...` never produces a double slash. */
function baseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * OUTBOX CONSUMER for the `email` topic.
 *
 * Turns a claimed `email` row into exactly one `EmailService.send`. The service
 * owns idempotency (the `(orderId, templateKey)` unique claim), suppression and
 * the delivery log; this handler only decides the payload and maps the result
 * union onto the dispatcher's throw-to-retry contract:
 *
 *  - sent / duplicate / suppressed → return (a terminal, correct outcome; the
 *    dispatcher marks the row processed and never retries)
 *  - failed                        → throw (transient: the dispatcher backs off)
 *  - rejected                      → throw (our bug: dead-letters and surfaces
 *                                    at /admin/jobs rather than vanishing)
 *
 * A reference row whose template needs data that does not exist yet (a
 * payment-receipt before the invoice number is allocated) throws too, so it is
 * retried until the upstream module fills the gap — which is the correct
 * ordering, not a failure.
 */
@Injectable()
export class EmailOutboxHandler implements OutboxHandler {
  readonly topic = "email";

  constructor(
    private readonly emails: EmailService,
    private readonly prisma: PrismaService,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async handle(payload: unknown, message: OutboxMessage): Promise<void> {
    const hydrated = hydratedEnvelopeSchema.safeParse(payload);
    if (hydrated.success) {
      const { templateKey, to, locale, orderId, dedupeScope } = hydrated.data;
      await this.deliver(templateKey, {
        to,
        locale,
        data: hydrated.data.payload,
        ...(orderId === undefined ? {} : { orderId }),
        ...(dedupeScope === undefined ? {} : { dedupeScope }),
      });
      return;
    }

    const reference = referenceEnvelopeSchema.safeParse(payload);
    if (reference.success) {
      const built = await this.hydrate(reference.data);
      await this.deliver(reference.data.templateKey, built);
      return;
    }

    // Neither shape parsed. This is a producer bug, not a transient fault, but
    // throwing (rather than dropping) keeps it visible in the dead-letter view.
    throw new Error(
      `Unrecognised email outbox payload on message ${message.id}: ${hydrated.error.message}`,
    );
  }

  private async deliver(
    templateKey: EmailTemplateKey,
    input: {
      readonly to: string;
      readonly locale: Locale;
      readonly data: Record<string, unknown>;
      readonly orderId?: string;
      readonly dedupeScope?: string;
    },
  ): Promise<void> {
    const result: EmailDispatchResult = await this.emails.sendChecked({
      templateKey,
      to: input.to,
      locale: input.locale,
      data: input.data,
      ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
      ...(input.dedupeScope === undefined ? {} : { dedupeScope: input.dedupeScope }),
    });

    switch (result.status) {
      case "sent":
      case "duplicate":
      case "suppressed":
        return;
      case "rejected":
        throw new Error(`Email "${templateKey}" rejected: ${result.error}`);
      case "failed":
        throw new Error(`Email "${templateKey}" delivery failed: ${result.error}`);
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled email dispatch result: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Assemble a template payload from the live order. Money is passed as plain
   * integer minor units in `{ amount, currency }` objects; `EmailService`
   * re-parses and brands them, so no `@akai/money` value crosses this boundary
   * un-validated.
   */
  private async hydrate(reference: ReferenceEnvelope): Promise<HydratedEmail> {
    const order = await this.prisma.order.findUnique({
      where: { id: reference.orderId },
      include: {
        items: { orderBy: { id: "asc" } },
        customer: true,
        // Only `delivery-confirmation` reads these, and it needs the LAST
        // parcel's timestamp — "delivered" is when the final one landed.
        shipments: { select: { deliveredAt: true } },
      },
    });

    if (order === null) {
      throw new Error(
        `Order ${reference.orderId} not found while building "${reference.templateKey}"`,
      );
    }

    const locale: Locale = reference.locale ?? order.locale;
    const firstName =
      order.customer?.firstName !== undefined && order.customer.firstName !== null
        ? order.customer.firstName
        : order.shipFirstName;
    const base = baseUrl(this.config.DASHBOARD_URL);
    const money = (amount: number): { amount: number; currency: string } => ({
      amount,
      currency: order.currency,
    });

    switch (reference.templateKey) {
      case "order-confirmation":
        return {
          to: order.email,
          locale,
          orderId: order.id,
          data: {
            firstName,
            orderNumber: order.orderNumber,
            placedAt: order.placedAt.toISOString(),
            lines: order.items.map((item) => ({
              name: item.productName,
              ...(item.variantName === null ? {} : { variantName: item.variantName }),
              quantity: item.quantity,
              unitPrice: money(item.unitPriceGross),
              lineTotal: money(item.lineTotalGross),
            })),
            subtotal: money(order.subtotal),
            discountTotal: money(order.discountTotal),
            shippingTotal: money(order.shippingTotal),
            taxTotal: money(order.taxTotal),
            grandTotal: money(order.grandTotal),
            orderUrl: `${base}/orders/${order.orderNumber}`,
          },
        };

      case "payment-receipt": {
        // The receipt references the invoice; the gap-free number is allocated
        // only at PAID (spec §13). If it is not there yet, defer by throwing so
        // the row is retried once InvoicesModule has allocated it.
        if (order.invoiceNumber === null) {
          throw new Error(
            `Invoice number not yet allocated for ${order.orderNumber}; deferring payment-receipt`,
          );
        }
        return {
          to: order.email,
          locale,
          orderId: order.id,
          data: {
            firstName,
            orderNumber: order.orderNumber,
            invoiceNumber: order.invoiceNumber,
            paidAt: (order.paidAt ?? order.placedAt).toISOString(),
            amountPaid: money(order.grandTotal),
            invoiceUrl: `${base}/orders/${order.orderNumber}/invoice`,
          },
        };
      }

      case "payment-failed":
        return {
          to: order.email,
          locale,
          orderId: order.id,
          data: {
            firstName,
            orderNumber: order.orderNumber,
            reason: await this.eventReason(
              order.id,
              "payment.failed",
              locale === "es"
                ? "No pudimos procesar el pago."
                : "We could not process the payment.",
            ),
            retryUrl: `${base}/orders/${order.orderNumber}`,
          },
        };

      case "order-cancelled":
        return {
          to: order.email,
          locale,
          orderId: order.id,
          data: {
            firstName,
            orderNumber: order.orderNumber,
            reason: await this.eventReason(
              order.id,
              "payment.canceled",
              locale === "es" ? "El pedido fue cancelado." : "The order was cancelled.",
            ),
            cancelledAt: (order.cancelledAt ?? order.updatedAt).toISOString(),
          },
        };

      case "delivery-confirmation": {
        // Both fields are derivable from the live order, so this is a REFERENCE
        // row: the mail reflects the order as it stands when it is actually
        // sent, not a snapshot frozen into the queue.
        const lastDelivery = order.shipments.reduce<Date | null>((latest, shipment) => {
          if (shipment.deliveredAt === null) {
            return latest;
          }
          return latest === null || shipment.deliveredAt > latest
            ? shipment.deliveredAt
            : latest;
        }, null);

        return {
          to: order.email,
          locale,
          orderId: order.id,
          data: {
            firstName,
            orderNumber: order.orderNumber,
            // `updatedAt` is the fallback and not the primary: it moves on any
            // later write, so a mail retried after an unrelated edit would
            // otherwise tell the customer the wrong delivery date.
            deliveredAt: (lastDelivery ?? order.updatedAt).toISOString(),
            orderUrl: `${base}/orders/${order.orderNumber}`,
          },
        };
      }

      case "refund-confirmation": {
        if (reference.amount === undefined) {
          throw new Error(
            `refund-confirmation for ${order.orderNumber} is missing the refunded amount`,
          );
        }
        const refundAmount = reference.amount;
        return {
          to: order.email,
          locale,
          orderId: order.id,
          data: {
            firstName,
            orderNumber: order.orderNumber,
            refundAmount: {
              amount: refundAmount,
              currency: reference.currency ?? order.currency,
            },
            reason: await this.eventReason(
              order.id,
              "refund.succeeded",
              locale === "es" ? "Reembolso procesado." : "Refund processed.",
            ),
            refundedAt: order.updatedAt.toISOString(),
            isPartial: refundAmount < order.grandTotal,
          },
        };
      }

      case "admin-new-order":
        return {
          // Staff alert: goes to the configured operations inbox, never the
          // customer. The payload deliberately carries the customer's email.
          to: this.config.EMAIL_FROM,
          locale,
          orderId: order.id,
          data: {
            orderNumber: order.orderNumber,
            customerEmail: order.email,
            itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
            grandTotal: money(order.grandTotal),
            placedAt: order.placedAt.toISOString(),
            adminUrl: `${base}/admin/orders/${order.id}`,
          },
        };

      case "verify-email":
      case "reset-password":
      case "login-code":
      case "shipping-confirmation":
      case "contact-autoreply":
      case "contact-received":
      case "affiliate-application-autoreply":
      case "affiliate-application-received":
        // verify/reset/login-code/contact/affiliate-application arrive fully
        // hydrated, never as references — the token, code or applicant data
        // exists only at emit time and there is no order to reference at all.
        //
        // `shipping-confirmation` is hydrated for a different reason: an order
        // reference names an order, and an order can hold several parcels, so
        // there is no way to tell WHICH one this mail is about. The producer
        // (OrdersService.createShipment) knows, builds the payload inside the
        // same transaction as the shipment, and scopes the claim by shipment id.
        throw new Error(
          `Template "${reference.templateKey}" cannot be built from an order reference`,
        );

      default: {
        const exhaustive: never = reference.templateKey;
        throw new Error(`Unhandled template key: ${String(exhaustive)}`);
      }
    }
  }

  /** Most recent order-event message of a type, for the customer-facing reason line. */
  private async eventReason(
    orderId: string,
    type: string,
    fallback: string,
  ): Promise<string> {
    const event = await this.prisma.orderEvent.findFirst({
      where: { orderId, type },
      orderBy: { createdAt: "desc" },
      select: { message: true },
    });
    const message = event?.message?.trim();
    if (message === undefined || message.length === 0) {
      return fallback;
    }
    // The reason line is capped at 300 chars by the template schema.
    return message.slice(0, 300);
  }
}
