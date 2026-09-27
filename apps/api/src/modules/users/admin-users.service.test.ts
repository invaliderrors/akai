import "reflect-metadata";
import { InternalServerErrorException } from "@nestjs/common";
import { RecordNotFoundError } from "@akai/db";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminUsersService, toSafeMinorUnits } from "./admin-users.service";
import type { AdminUserListQuery } from "./dto/users.dto";
import {
  FakeUsersRepository,
  makeCustomerRow,
} from "./test-doubles/fake-users.repository";

function query(overrides: Partial<AdminUserListQuery> = {}): AdminUserListQuery {
  return { limit: 24, ...overrides };
}

describe("AdminUsersService", () => {
  let repository: FakeUsersRepository;
  let service: AdminUsersService;

  beforeEach(() => {
    repository = new FakeUsersRepository();
    service = new AdminUsersService(repository);
  });

  describe("pagination", () => {
    beforeEach(() => {
      repository.customers = Array.from({ length: 5 }, (_unused, index) =>
        makeCustomerRow({
          email: `customer-${index}@example.com`,
          createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        }),
      );
    });

    it("returns a page and reports that more remain", async () => {
      const page = await service.list(query({ limit: 2 }));

      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).not.toBeNull();
    });

    it("walks the whole set without repeating or skipping a row", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let guard = 0; guard < 10; guard += 1) {
        const page: Awaited<ReturnType<AdminUsersService["list"]>> = await service.list(
          query({ limit: 2, ...(cursor !== null ? { cursor } : {}) }),
        );
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        if (!page.hasMore) {
          break;
        }
      }

      // Both properties matter. Cursor pagination exists precisely to avoid the
      // duplicate/skip behaviour OFFSET shows under concurrent writes.
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("reports the final page as terminal", async () => {
      const page = await service.list(query({ limit: 50 }));

      expect(page.items).toHaveLength(5);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe("filtering", () => {
    beforeEach(() => {
      repository.customers = [
        makeCustomerRow({ email: "ana@example.com", role: "CUSTOMER" }),
        makeCustomerRow({ email: "staff@akai.shop", role: "STAFF" }),
        makeCustomerRow({
          email: "gone@example.com",
          role: "CUSTOMER",
          anonymisedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ];
    });

    it("filters by email substring, case-insensitively", async () => {
      const page = await service.list(query({ email: "AKAI" }));

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.email).toBe("staff@akai.shop");
    });

    it("filters by role", async () => {
      const page = await service.list(query({ role: "STAFF" }));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.role).toBe("STAFF");
    });

    it("filters anonymised accounts in and out", async () => {
      const erased = await service.list(query({ anonymised: true }));
      const live = await service.list(query({ anonymised: false }));

      expect(erased.items).toHaveLength(1);
      expect(erased.items[0]?.email).toBe("gone@example.com");
      expect(live.items).toHaveLength(2);
    });

    it("filters by creation window", async () => {
      repository.customers = [
        makeCustomerRow({ createdAt: new Date("2026-01-01T00:00:00.000Z") }),
        makeCustomerRow({ createdAt: new Date("2026-06-01T00:00:00.000Z") }),
      ];

      const page = await service.list(
        query({ createdAfter: "2026-03-01T00:00:00.000Z" }),
      );

      expect(page.items).toHaveLength(1);
    });
  });

  describe("order statistics", () => {
    const customer = makeCustomerRow();

    beforeEach(() => {
      repository.customers = [customer];
    });

    it("reports zeroes for a customer with no orders", async () => {
      const view = await service.get(customer.id);

      // No stats row exists (GROUP BY returns nothing) — that is a zero, not a
      // missing value, and certainly not a crash.
      expect(view.orderCount).toBe(0);
      expect(view.lifetimeValueMinor).toBe(0);
      expect(view.lastOrderAt).toBeNull();
    });

    it("sums lifetime value in integer minor units", async () => {
      repository.orders = [
        {
          customerId: customer.id,
          orderNumber: "AK-1",
          status: "DELIVERED",
          currency: "EUR",
          grandTotal: 4999,
          refundedTotal: 0,
          placedAt: new Date("2026-01-01T00:00:00.000Z"),
          invoiceNumber: "INV-1",
        },
        {
          customerId: customer.id,
          orderNumber: "AK-2",
          status: "PAID",
          currency: "EUR",
          grandTotal: 2500,
          refundedTotal: 0,
          placedAt: new Date("2026-02-01T00:00:00.000Z"),
          invoiceNumber: "INV-2",
        },
      ];

      const view = await service.get(customer.id);

      expect(view.orderCount).toBe(2);
      expect(view.lifetimeValueMinor).toBe(7499);
      expect(view.lastOrderAt).toBe(new Date("2026-02-01T00:00:00.000Z").toISOString());
    });

    it("nets refunds off lifetime value", async () => {
      repository.orders = [
        {
          customerId: customer.id,
          orderNumber: "AK-1",
          status: "PARTIALLY_REFUNDED",
          currency: "EUR",
          grandTotal: 4999,
          refundedTotal: 1000,
          placedAt: new Date("2026-01-01T00:00:00.000Z"),
          invoiceNumber: "INV-1",
        },
      ];

      // A customer who was refunded did not spend that money. Counting the gross
      // would overstate every LTV figure the business plans against.
      expect((await service.get(customer.id)).lifetimeValueMinor).toBe(3999);
    });

    it("excludes unpaid orders from lifetime value", async () => {
      repository.orders = [
        {
          customerId: customer.id,
          orderNumber: "AK-1",
          status: "PENDING",
          currency: "EUR",
          grandTotal: 9999,
          refundedTotal: 0,
          placedAt: new Date("2026-01-01T00:00:00.000Z"),
          invoiceNumber: null,
        },
      ];

      // A PENDING order is an abandoned cart, not revenue.
      const view = await service.get(customer.id);
      expect(view.orderCount).toBe(0);
      expect(view.lifetimeValueMinor).toBe(0);
    });

    it("raises not-found for an unknown customer", async () => {
      await expect(
        service.get("00000000-0000-4000-8000-000000000000"),
      ).rejects.toThrow(RecordNotFoundError);
    });
  });
});

/**
 * Spec §4's overflow rule, tested at the conversion point.
 *
 * The SQL casts to bigint so Postgres does not overflow a 32-bit sum. That gets
 * the number out intact — but `Number(bigint)` past 2^53 loses precision
 * SILENTLY, producing a plausible wrong total. The conversion therefore throws
 * rather than rounding.
 */
describe("toSafeMinorUnits", () => {
  it("converts a value inside the safe range", () => {
    expect(toSafeMinorUnits(7499n)).toBe(7499);
    expect(toSafeMinorUnits(0n)).toBe(0);
  });

  it("accepts the largest safe integer exactly", () => {
    expect(toSafeMinorUnits(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("throws rather than silently losing precision beyond 2^53", () => {
    expect(() => toSafeMinorUnits(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      InternalServerErrorException,
    );
  });

  it("rejects a negative total as an invariant violation", () => {
    // Refunding more than was charged is something the database CHECK
    // constraints are supposed to prevent; if it reaches here, reporting a
    // negative lifetime value on an admin screen is the wrong response.
    expect(() => toSafeMinorUnits(-1n)).toThrow(InternalServerErrorException);
  });
});
