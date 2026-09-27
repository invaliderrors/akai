import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "@akai/observability";

import { LOGGER } from "../../observability/logger.module";
import type { OutboxHandler, OutboxMessage } from "../../outbox/outbox.types";
import { ShipmentSyncService } from "./shipment-sync.service";
import { SHIPMENT_SYNC_TOPIC, shipmentSyncPayloadSchema } from "./shipment-sync.types";

/**
 * OUTBOX CONSUMER for `shipment-sync`.
 *
 * At-least-once delivery is safe by construction: the sync re-reads Sendcloud's
 * current state and only ever moves a shipment forward, and every side effect
 * (the first-scan mail, the pickup mail) is guarded by a conditional UPDATE in
 * the same transaction. A vendor error throws, so the dispatcher backs off and
 * retries; after eight attempts the row dead-letters at /admin/jobs and the
 * 2-hourly sweep picks the shipment up again anyway.
 */
@Injectable()
export class ShipmentSyncOutboxHandler implements OutboxHandler {
  readonly topic = SHIPMENT_SYNC_TOPIC;

  constructor(
    @Inject(ShipmentSyncService) private readonly sync: Pick<ShipmentSyncService, "sync">,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async handle(payload: unknown, message: OutboxMessage): Promise<void> {
    // Parsed, not cast: the row is JSONB, possibly written by an older deploy.
    const parsed = shipmentSyncPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Unrecognised shipment-sync payload on message ${message.id}: ${parsed.error.message}`,
      );
    }

    const outcome = await this.sync.sync(parsed.data.shipmentId);
    this.logger.debug({ shipmentId: parsed.data.shipmentId, outcome }, "Shipment synced from Sendcloud");
  }
}
