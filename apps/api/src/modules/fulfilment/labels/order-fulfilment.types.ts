import { z } from "zod";

/**
 * The `order-fulfilment` outbox topic (spec §3.6): "buy the label for this
 * order". Produced ONLY by staff — the admin bulk/single generate and the
 * retry of a FAILED label (decision D3: labels are bought when staff click,
 * never on payment). Consumed by `OrderFulfilmentOutboxHandler`.
 *
 * The topic name predates this consumer: `order-settlement.ts` reserved it
 * for an automatic "prepare" job that D3 ruled out, which is why the payload
 * is an `action`-discriminated union with one member rather than a flat shape
 * — a second action (say, a return label) is a new member, not a new topic.
 *
 * `actorId` is the staff member who clicked, recorded on the order timeline.
 */
export const ORDER_FULFILMENT_TOPIC = "order-fulfilment";

export const orderFulfilmentPayloadSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create-label"),
      orderId: z.string().uuid(),
      actorId: z.string().uuid().nullable(),
    })
    .strict(),
]);

export type OrderFulfilmentPayload = z.infer<typeof orderFulfilmentPayloadSchema>;
