/**
 * Ownership-scoped query helpers.
 *
 * IDOR (resolving a record by `id` alone and forgetting to check who owns it) is
 * the single most common vulnerability in customer dashboards: `/orders/:id`
 * with someone else's id returns someone else's invoice, address and full name.
 *
 * The defence is not "remember to add customerId to the where clause" — that is
 * exactly the thing people forget. It is to make the OWNED query the ergonomic
 * one, so a bare `findUnique({ where: { id } })` on a customer-owned table
 * stands out in review as the anomaly it is.
 */

/** A where-clause fragment that scopes a lookup to a single owner. */
export interface OwnedWhere {
  readonly id: string;
  readonly customerId: string;
}

/**
 * Build a where clause that resolves by (id AND customerId), never id alone.
 *
 * A non-owner gets zero rows — which the caller surfaces as 404, not 403.
 * Returning 403 would confirm the record exists, letting an attacker enumerate
 * valid order ids.
 */
export function ownedBy(id: string, customerId: string): OwnedWhere {
  return { id, customerId };
}

/**
 * Scope a lookup by the human-readable order number instead of the UUID.
 * Customers quote order numbers to support, so this is the lookup the dashboard
 * actually performs — and it needs the same ownership scoping.
 */
export interface OwnedOrderNumberWhere {
  readonly orderNumber: string;
  readonly customerId: string;
}

export function ownedByOrderNumber(
  orderNumber: string,
  customerId: string,
): OwnedOrderNumberWhere {
  return { orderNumber, customerId };
}

/**
 * Exclude soft-deleted rows.
 *
 * Soft delete only protects history if every read remembers to filter. Compose
 * this into a where clause rather than writing `deletedAt: null` by hand, so the
 * intent is greppable and a future change of representation has one edit site.
 */
export const notDeleted = { deletedAt: null } as const;

/**
 * Assert a scoped lookup actually returned something.
 *
 * Narrows `T | null` to `T`, so callers get a non-null value without reaching
 * for a `!` non-null assertion — which is banned precisely because it hides the
 * case this function makes explicit.
 */
export function assertFound<T>(
  value: T | null | undefined,
  entity: string,
): T {
  if (value === null || value === undefined) {
    throw new RecordNotFoundError(entity);
  }
  return value;
}

/**
 * Thrown when an ownership-scoped lookup finds nothing.
 *
 * Deliberately does NOT distinguish "does not exist" from "belongs to someone
 * else": the exception filter maps this to 404 either way, so the response
 * cannot be used to enumerate ids that exist.
 */
export class RecordNotFoundError extends Error {
  public readonly entity: string;

  constructor(entity: string) {
    super(`${entity} not found`);
    this.name = "RecordNotFoundError";
    this.entity = entity;
  }
}
