import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "@akai/observability";

import { LOGGER } from "../../observability/logger.module";
import type { OutboxHandler, OutboxMessage } from "../../outbox/outbox.types";
import { LabelService } from "./label.service";
import { ORDER_FULFILMENT_TOPIC, orderFulfilmentPayloadSchema } from "./order-fulfilment.types";

/**
 * OUTBOX CONSUMER for `order-fulfilment` (spec §3.6).
 *
 * AT-LEAST-ONCE DELIVERY IS SAFE HERE, and by construction rather than by a
 * dedupe table: a redelivered `create-label` either finds the order already
 * labelled (eligibility says ALREADY_LABELLED — nothing is sent to Sendcloud)
 * or, after a crash between purchase and record, re-sends the SAME
 * `external_reference_id` and is handed back the label already bought (409
 * reuse). Neither path buys a second label.
 *
 * Throws only for "try again" — `LabelService` returns every settled answer,
 * including a refused label (a FAILED shipment row) and an order that is no
 * longer eligible (logged, marked done). A payload that does not parse throws,
 * so a producer bug dead-letters visibly at /admin/jobs.
 */
@Injectable()
export class OrderFulfilmentOutboxHandler implements OutboxHandler {
  readonly topic = ORDER_FULFILMENT_TOPIC;

  constructor(
    private readonly labels: LabelService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async handle(payload: unknown, message: OutboxMessage): Promise<void> {
    const parsed = orderFulfilmentPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Unrecognised order-fulfilment payload on message ${message.id}: ${parsed.error.message}`,
      );
    }

    const { orderId, actorId } = parsed.data;
    const outcome = await this.labels.createForOrder(orderId, actorId);

    if (outcome.kind === "skipped") {
      this.logger.info(
        { outboxId: message.id, orderId, reason: outcome.reason },
        "Label job skipped: the order is no longer eligible",
      );
    }
  }
}
