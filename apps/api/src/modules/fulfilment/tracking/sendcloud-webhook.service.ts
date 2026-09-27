import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "@akai/observability";
import { Prisma } from "@prisma/client";

import { LOGGER } from "../../observability/logger.module";
import { PrismaService } from "../../prisma/prisma.service";
import { SHIPMENT_SYNC_TOPIC, type ShipmentSyncPayload } from "./shipment-sync.types";

/**
 * Records a verified Sendcloud "parcel status changed" delivery and enqueues a
 * `shipment-sync` for the shipment it names.
 *
 * THE WEBHOOK DOES NO TRACKING WORK. It answers fast (Sendcloud retries 10
 * times, 5 min → 1 h, on a slow or failed answer), and the sync — a vendor read
 * and possibly an order transition plus emails — runs from the outbox, where it
 * gets retries, backoff and a dead-letter row for free.
 */

export type SendcloudWebhookOutcome =
  | { readonly status: "enqueued"; readonly shipmentId: string }
  | { readonly status: "duplicate" }
  | { readonly status: "unmatched" };

export interface SendcloudParcelEvent {
  readonly parcelId: bigint;
  /** The dedupe key (`sendcloud:{parcelId}:{timestamp}`), built by the controller. */
  readonly eventId: string;
  readonly action: string;
}

/**
 * Only `$transaction` is used; narrowing to it lets an integration test hand
 * this a plain container-backed client (the ResendWebhookService precedent).
 */
type WebhookPrismaClient = Pick<PrismaService, "$transaction">;

/** `provider_event.id` is VarChar(128). */
const MAX_EVENT_ID_LENGTH = 128;

@Injectable()
export class SendcloudWebhookService {
  constructor(
    @Inject(PrismaService) private readonly prisma: WebhookPrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async accept(event: SendcloudParcelEvent): Promise<SendcloudWebhookOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The dedupe INSERT and the enqueue share ONE transaction (spec §9): a
        // concurrent redelivery hits the primary key and rolls back, so one
        // delivery yields at most one sync message.
        await tx.providerEvent.create({
          data: {
            id: event.eventId.slice(0, MAX_EVENT_ID_LENGTH),
            type: `sendcloud.${event.action}`.slice(0, 64),
          },
        });

        const shipment = await tx.shipment.findUnique({
          where: { sendcloudParcelId: event.parcelId },
          select: { id: true },
        });

        if (shipment === null) {
          // Answered 2xx deliberately. A parcel we do not know — made by hand in
          // the panel, or by another environment sharing the integration — will
          // never become known by retrying, and a non-2xx would earn ten retries
          // per status change. The provider_event row still commits, so a
          // retry of this same delivery is not re-logged.
          this.logger.warn(
            { parcelId: event.parcelId.toString(), action: event.action },
            "Sendcloud webhook for a parcel with no shipment row — ignored",
          );
          return { status: "unmatched" } as const;
        }

        const payload: ShipmentSyncPayload = { shipmentId: shipment.id };
        await tx.outboxMessage.create({
          data: { topic: SHIPMENT_SYNC_TOPIC, payload },
        });

        return { status: "enqueued", shipmentId: shipment.id } as const;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { status: "duplicate" };
      }
      throw error;
    }
  }
}
