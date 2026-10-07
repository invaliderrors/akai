import { z } from "zod";
import { idSchema } from "@akai/contracts";

/**
 * Catalog change REASONS.
 *
 * THE `product.*` AND `variant.*` MEMBERS ARE NO LONGER PUBLISHED AS TOPICS.
 * They were domain events on the transactional outbox with exactly one consumer
 * — the TagadaPay catalog mirror — because a hosted checkout there could
 * reference a mirrored variant and no amount, so an unmirrored variant could not
 * be sold and every catalog write was a sync obligation. Wompi takes our
 * computed amount directly on the checkout call, so the mirror, its consumer and
 * those rows are gone; an outbox row whose only handler was deleted does not sit
 * harmlessly, it dead-letters into /admin/jobs on every product edit.
 *
 * WHAT THEY STILL DO is name the change that justified a storefront cache purge,
 * as the `reason` on the `storefront.revalidate` row that IS still written — in
 * the same Prisma transaction as the catalog write, so there is no window in
 * which the product changed but the purge intent was lost. That row is what an
 * operator reads when asking why a tag was invalidated.
 *
 * `inventoryAdjusted` IS THE EXCEPTION and is still a real topic: it is written
 * by `ProductInventoryService` and has no consumer yet, so it dead-letters at
 * /admin/jobs by the same deliberate convention as `invoice-pdf` and
 * `order-fulfilment` — visible work waiting on a module that has not shipped,
 * rather than a silently discarded event. Its consumer is `notifications`
 * (low-stock alerts).
 */
export const CATALOG_TOPICS = {
  productCreated: "catalog.product.created",
  productUpdated: "catalog.product.updated",
  productPublished: "catalog.product.published",
  productUnpublished: "catalog.product.unpublished",
  productArchived: "catalog.product.archived",
  productRestored: "catalog.product.restored",
  variantCreated: "catalog.variant.created",
  variantUpdated: "catalog.variant.updated",
  /**
   * Distinct from variantUpdated, and it survives both provider migrations for a
   * reason that has changed each time. Under Stripe a Price was immutable and had
   * to be re-created; under TagadaPay a mirrored variant had no reprice path at
   * all. Under Wompi neither problem exists — the price rides on the checkout
   * call — so what it buys now is legibility: an operator reading a purge can
   * tell a price change from any other variant edit, which is the one catalog
   * change with financial consequences.
   */
  variantPriceChanged: "catalog.variant.price_changed",
  variantDeactivated: "catalog.variant.deactivated",
  inventoryAdjusted: "catalog.inventory.adjusted",
  /**
   * The category admin CRUD's four write reasons. `ProductsService` writes
   * these, not `CategoriesService` — category CRUD deliberately lives beside
   * the product/category ASSIGNMENT write it must stay consistent with (see
   * `CategoriesModule`'s own doc comment), and `CategoriesService` owns
   * reading the list only.
   */
  categoryCreated: "catalog.category.created",
  categoryUpdated: "catalog.category.updated",
  categoryReordered: "catalog.category.reordered",
  categoryDeleted: "catalog.category.deleted",
} as const;

export type CatalogTopic = (typeof CATALOG_TOPICS)[keyof typeof CATALOG_TOPICS];

/**
 * The inventory event's payload — the ONLY one left.
 *
 * `productEventPayloadSchema`, `variantEventPayloadSchema` and
 * `priceChangedPayloadSchema` are deleted with the mirror consumer that read
 * them: ids and changed facts assembled for a reader that no longer exists. The
 * purge row carries a `reason` and two cache tags, and needs none of it.
 */
export const inventoryEventPayloadSchema = z
  .object({
    variantId: idSchema,
    onHand: z.number().int(),
    available: z.number().int(),
    lowStock: z.boolean(),
    actorId: idSchema.nullable(),
  })
  .strict();

export type InventoryEventPayload = z.infer<typeof inventoryEventPayloadSchema>;
