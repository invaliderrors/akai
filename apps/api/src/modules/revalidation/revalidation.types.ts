import { z } from "zod";

/**
 * Storefront cache invalidation, as an outbox topic.
 *
 * WHY A DEDICATED TOPIC rather than a second handler on the `catalog.*` topics:
 * `OutboxDispatcher.register` REFUSES a second, different handler for the same
 * topic, and it is right to — a silent double-binding would split delivery
 * between two implementations depending on registration order. Those topics were
 * owned by the TagadaPay catalog mirror at the time, and are no longer produced
 * at all now that the mirror is gone. The separation outlived its original reason
 * and is still correct: a purge gets its own row, its own retry budget and its own
 * dead-letter entry, so a storefront that is down delays nothing else.
 */
export const REVALIDATION_TOPIC = "storefront.revalidate";

/**
 * What to invalidate.
 *
 * TAGS, not paths. The storefront's ISR entries are tagged (`revalidateTag`),
 * and a path list would have to enumerate every page a product
 * appears on — home, catalog, category, PDP, bundles — and would go stale the
 * moment a page was added. `reason` is carried for the log line only; nothing
 * branches on it.
 */
export const revalidationPayloadSchema = z
  .object({
    tags: z.array(z.string().min(1).max(128)).min(1).max(50),
    reason: z.string().max(120),
  })
  .strict();

export type RevalidationPayload = z.infer<typeof revalidationPayloadSchema>;
