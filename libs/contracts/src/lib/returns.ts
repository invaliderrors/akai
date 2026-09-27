import { z } from "zod";
import { idSchema, isoDateTimeSchema, paginatedSchema } from "./common";
import { returnStatusSchema as statusSchema, type ReturnStatus } from "./enums";

/**
 * Returns (RMA).
 *
 * THE MODEL IS WHOLE-ORDER, NOT PER-LINE, and that is the schema's existing
 * shape rather than a simplification made here: `return_request` has a reason and
 * a status and no line items. For a small clothing shop that is a reasonable
 * starting point — most returns are handled as one parcel — and inventing a
 * `ReturnItem` table to model something the business may not do would be
 * speculative.
 *
 * IT DOES NOT MOVE MONEY. Approving a return records a decision; refunding is a
 * separate, already-implemented action at
 * `POST /v1/admin/orders/:orderNumber/refunds`, which talks to the payment
 * provider and has its own idempotency. Chaining them automatically would put an
 * irreversible transfer behind a status dropdown.
 */

/**
 * The status enum lives in `enums.ts` alongside every other Prisma-mirroring
 * enum, and is re-exported here so a caller working on returns has one import.
 * Declaring a second copy would be two sources of truth for one column.
 */
export { returnStatusSchema, type ReturnStatus } from "./enums";

/**
 * Statuses from which a request may still move, and where to.
 *
 * A CLOSED map rather than "anything to anything": without it an operator can
 * walk a REJECTED request to REFUNDED and issue money against a decision that
 * was never approved. Terminal states have an empty list.
 */
export const RETURN_TRANSITIONS = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["IN_TRANSIT", "REJECTED"],
  IN_TRANSIT: ["RECEIVED"],
  RECEIVED: ["REFUNDED"],
  REJECTED: [],
  REFUNDED: [],
} as const satisfies Record<ReturnStatus, readonly ReturnStatus[]>;

export function canTransitionReturn(from: ReturnStatus, to: ReturnStatus): boolean {
  const allowed: readonly ReturnStatus[] = RETURN_TRANSITIONS[from];
  return allowed.includes(to);
}

/** True while the request is still open — neither refunded nor rejected. */
export function isReturnOpen(status: ReturnStatus): boolean {
  return RETURN_TRANSITIONS[status].length > 0;
}

export const returnRequestSchema = z
  .object({
    id: idSchema,
    orderId: idSchema,
    /** Denormalised for display; a customer knows the number, not the uuid. */
    orderNumber: z.string().min(1).max(32),
    status: statusSchema,
    reason: z.string().min(1).max(500),
    /** Operator-written, and shown to the customer — so it is customer-facing copy. */
    adminNote: z.string().max(1000).nullable(),
    returnLabelUrl: z.string().max(1024).nullable(),
    requestedAt: isoDateTimeSchema,
    resolvedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type ReturnRequest = z.infer<typeof returnRequestSchema>;

export const paginatedReturnsSchema = paginatedSchema(returnRequestSchema);
export type PaginatedReturns = z.infer<typeof paginatedReturnsSchema>;

export const createReturnRequestSchema = z
  .object({
    /** The ORDER NUMBER, not the id: it is the only reference a customer holds. */
    orderNumber: z.string().min(1).max(32),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type CreateReturnRequest = z.infer<typeof createReturnRequestSchema>;

export const updateReturnRequestSchema = z
  .object({
    status: statusSchema,
    adminNote: z.string().max(1000).nullable().optional(),
    returnLabelUrl: z.string().url().max(1024).nullable().optional(),
  })
  .strict();

export type UpdateReturnRequest = z.infer<typeof updateReturnRequestSchema>;

export const listReturnsQuerySchema = z
  .object({
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: statusSchema.optional(),
  })
  .strict();

export type ListReturnsQuery = z.infer<typeof listReturnsQuerySchema>;
