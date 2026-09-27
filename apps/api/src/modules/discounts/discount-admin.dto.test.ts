import { describe, expect, it } from "vitest";

import { listDiscountsQuerySchema } from "./discount-admin.dto";

/**
 * REGRESSION. `includeDeleted` was `z.coerce.boolean()`, which is JavaScript
 * truthiness over a value that arrives from a query string as TEXT. The service
 * tests never caught it because they call the service with a real boolean and
 * never exercise the wire representation, so the filter was inert in production
 * while every unit test passed: soft-deleted coupons appeared on every page load
 * and the operator's "include archived" checkbox changed nothing.
 */
describe("listDiscountsQuerySchema.includeDeleted", () => {
  it('parses the STRING "false" as false — the whole bug', () => {
    const parsed = listDiscountsQuerySchema.parse({ includeDeleted: "false" });
    expect(parsed.includeDeleted).toBe(false);
  });

  it('parses the STRING "true" as true', () => {
    expect(listDiscountsQuerySchema.parse({ includeDeleted: "true" }).includeDeleted).toBe(true);
  });

  it("defaults to false when the caller omits it", () => {
    expect(listDiscountsQuerySchema.parse({}).includeDeleted).toBe(false);
  });

  it("REJECTS a value that is neither, rather than silently coercing it", () => {
    expect(listDiscountsQuerySchema.safeParse({ includeDeleted: "yes" }).success).toBe(false);
    expect(listDiscountsQuerySchema.safeParse({ includeDeleted: "1" }).success).toBe(false);
  });
});
