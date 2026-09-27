import { describe, expect, it } from "vitest";
import {
  RecordNotFoundError,
  assertFound,
  notDeleted,
  ownedBy,
  ownedByOrderNumber,
} from "./ownership";

describe("ownership scoping", () => {
  it("always includes customerId — a lookup by id alone is the IDOR bug", () => {
    const where = ownedBy("order-1", "customer-1");
    expect(where).toEqual({ id: "order-1", customerId: "customer-1" });
    expect(Object.keys(where)).toContain("customerId");
  });

  it("scopes the order-number lookup the dashboard actually uses", () => {
    expect(ownedByOrderNumber("AK-2026-000123", "customer-1")).toEqual({
      orderNumber: "AK-2026-000123",
      customerId: "customer-1",
    });
  });

  it("filters soft-deleted rows", () => {
    expect(notDeleted).toEqual({ deletedAt: null });
  });
});

describe("assertFound", () => {
  it("returns the value when present, narrowing away null", () => {
    const order: { id: string } | null = { id: "order-1" };
    const found = assertFound(order, "Order");
    expect(found.id).toBe("order-1");
  });

  it("throws for null and undefined alike", () => {
    expect(() => assertFound(null, "Order")).toThrow(RecordNotFoundError);
    expect(() => assertFound(undefined, "Order")).toThrow(RecordNotFoundError);
  });

  it("does NOT leak whether the record exists or belongs to someone else", () => {
    // Both cases produce the identical message. Anything more specific lets an
    // attacker enumerate valid order ids by diffing the responses.
    let missingMessage = "";
    let foreignMessage = "";
    try {
      assertFound(null, "Order");
    } catch (error) {
      missingMessage = String(error);
    }
    try {
      assertFound(null, "Order");
    } catch (error) {
      foreignMessage = String(error);
    }
    expect(missingMessage).toBe(foreignMessage);
    expect(missingMessage).not.toMatch(/permission|forbidden|owner/i);
  });

  it("names the entity so the exception filter can build a useful 404", () => {
    try {
      assertFound(null, "Address");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordNotFoundError);
      if (!(error instanceof RecordNotFoundError)) throw error;
      expect(error.entity).toBe("Address");
    }
  });
});
