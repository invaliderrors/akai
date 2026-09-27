import { z } from "zod";

/**
 * The `shipment-sync` outbox topic: "re-read this shipment from Sendcloud and
 * apply what it says". Produced by the tracking webhook and by the 2-hourly
 * sweep; consumed by `ShipmentSyncOutboxHandler`.
 *
 * The payload names OUR shipment id and nothing else. The state is never
 * carried in the message — the whole design (spec §3.7) is that the consumer
 * reads the CURRENT state at run time, so a message processed late, twice or
 * out of order converges on the same answer.
 */
export const SHIPMENT_SYNC_TOPIC = "shipment-sync";

export const shipmentSyncPayloadSchema = z.object({
  shipmentId: z.string().uuid(),
});

export type ShipmentSyncPayload = z.infer<typeof shipmentSyncPayloadSchema>;
