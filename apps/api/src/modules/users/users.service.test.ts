import "reflect-metadata";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { RecordNotFoundError } from "@akai/db";
import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "./clock";
import {
  FakeUsersRepository,
  makeCustomerRow,
} from "./test-doubles/fake-users.repository";
import { UsersService, tombstoneEmail } from "./users.service";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const clock: Clock = { now: () => NOW };

describe("UsersService", () => {
  let repository: FakeUsersRepository;
  let service: UsersService;
  let customer = makeCustomerRow();

  beforeEach(() => {
    customer = makeCustomerRow({ email: "ana@example.com", firstName: "Ana" });
    repository = new FakeUsersRepository();
    repository.customers = [customer];
    service = new UsersService(repository, clock);
  });

  describe("profile", () => {
    it("returns the caller's profile", async () => {
      const profile = await service.getProfile(customer.id);
      expect(profile.email).toBe("ana@example.com");
      expect(profile.firstName).toBe("Ana");
    });

    it("raises not-found for an unknown customer", async () => {
      await expect(
        service.getProfile("00000000-0000-4000-8000-000000000000"),
      ).rejects.toThrow(RecordNotFoundError);
    });

    it("applies a partial update", async () => {
      const updated = await service.updateProfile(customer.id, { firstName: "Anita" });
      expect(updated.firstName).toBe("Anita");
      expect(updated.lastName).toBe("García");
    });

    it("clears a nullable field when explicitly set to null", async () => {
      await service.updateProfile(customer.id, { phone: "+34600000000" });
      const cleared = await service.updateProfile(customer.id, { phone: null });
      expect(cleared.phone).toBeNull();
    });

    it("treats an empty patch as a no-op rather than a write", async () => {
      const before = await service.getProfile(customer.id);
      const after = await service.updateProfile(customer.id, {});
      // updatedAt is untouched: no pointless write, no misleading "last modified".
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("refuses to modify a closed account", async () => {
      await service.requestErasure(customer.id, { confirmEmail: customer.email });

      await expect(
        service.updateProfile(customer.id, { firstName: "Resurrected" }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("GDPR export", () => {
    beforeEach(() => {
      repository.orders = [
        {
          customerId: customer.id,
          orderNumber: "AK-2026-000001",
          status: "DELIVERED",
          currency: "EUR",
          grandTotal: 4999,
          refundedTotal: 0,
          placedAt: new Date("2026-05-01T00:00:00.000Z"),
          invoiceNumber: "INV-2026-1",
        },
      ];
      repository.consents = [
        {
          customerId: customer.id,
          kind: "marketing",
          version: "v2",
          granted: true,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ];
      repository.emails = [
        {
          recipient: customer.email,
          templateKey: "order-confirmation",
          status: "SENT",
          sentAt: new Date("2026-05-01T00:05:00.000Z"),
        },
      ];
      repository.sessions = [
        {
          customerId: customer.id,
          id: "33333333-3333-4333-8333-333333333333",
          createdAt: NOW,
          lastSeenAt: NOW,
          ipAddress: "203.0.113.9",
          userAgent: "Firefox",
          revokedAt: null,
        },
      ];
    });

    it("assembles every category of the caller's personal data", async () => {
      const output = await service.exportPersonalData(customer.id);

      expect(output.formatVersion).toBe(1);
      expect(output.generatedAt).toBe(NOW.toISOString());
      expect(output.profile.id).toBe(customer.id);
      expect(output.orders).toHaveLength(1);
      expect(output.consents).toHaveLength(1);
      expect(output.emails).toHaveLength(1);
      expect(output.sessions).toHaveLength(1);
    });

    it("exports money as integer minor units, not a formatted string", async () => {
      const output = await service.exportPersonalData(customer.id);
      const [order] = output.orders;

      expect(order?.grandTotal).toBe(4999);
      expect(typeof order?.grandTotal).toBe("number");
      expect(Number.isInteger(order?.grandTotal)).toBe(true);
    });

    it("carries no credential material into the export", async () => {
      const output = await service.exportPersonalData(customer.id);
      const serialised = JSON.stringify(output);

      // The export is a file a customer downloads and forwards. Anything secret
      // in it is secret no longer.
      expect(serialised).not.toContain("passwordHash");
      expect(serialised).not.toContain("totpSecret");
    });
  });

  describe("erasure", () => {
    it("anonymises in place rather than deleting", async () => {
      const result = await service.requestErasure(customer.id, {
        confirmEmail: customer.email,
      });

      expect(result.anonymisedAt).toBe(NOW.toISOString());

      const after = await service.getProfile(customer.id);
      expect(after.anonymisedAt).toBe(NOW.toISOString());
      expect(after.firstName).toBeNull();
      expect(after.lastName).toBeNull();
      expect(after.phone).toBeNull();
      expect(after.email).toBe(tombstoneEmail(customer.id));
    });

    it("uses a unique, non-routable tombstone address", async () => {
      await service.requestErasure(customer.id, { confirmEmail: customer.email });
      const after = await service.getProfile(customer.id);

      // `.invalid` is reserved by RFC 2606 and can never resolve, so the
      // tombstone cannot be mailed by a later job that iterates customers.
      expect(after.email.endsWith("@akai.invalid")).toBe(true);
      // Derived from the id, so a second erasure produces the same value rather
      // than colliding with the UNIQUE constraint on email.
      expect(after.email).toContain(customer.id);
    });

    it("retains orders and reports how many", async () => {
      repository.orders = [
        {
          customerId: customer.id,
          orderNumber: "AK-2026-000001",
          status: "DELIVERED",
          currency: "EUR",
          grandTotal: 4999,
          refundedTotal: 0,
          placedAt: new Date("2026-01-01T00:00:00.000Z"),
          invoiceNumber: "INV-1",
        },
      ];

      const result = await service.requestErasure(customer.id, {
        confirmEmail: customer.email,
      });

      // GDPR Art. 17(3)(b): invoice retention is a legal obligation that
      // overrides erasure. The order must survive the tombstoning.
      expect(result.ordersRetained).toBe(1);
      expect(repository.orders).toHaveLength(1);
    });

    it("revokes every session and refresh token", async () => {
      repository.sessions = [
        {
          customerId: customer.id,
          id: "33333333-3333-4333-8333-333333333333",
          createdAt: NOW,
          lastSeenAt: NOW,
          ipAddress: null,
          userAgent: null,
          revokedAt: null,
        },
      ];
      repository.refreshTokens = [{ customerId: customer.id, revokedAt: null }];
      repository.recoveryCodes = [{ customerId: customer.id }];

      const result = await service.requestErasure(customer.id, {
        confirmEmail: customer.email,
      });

      // A tombstoned profile whose sessions still authenticate is worse than no
      // erasure: the account is unrecoverable AND still reachable.
      expect(result.sessionsRevoked).toBe(1);
      expect(repository.sessions.every((s) => s.revokedAt !== null)).toBe(true);
      expect(repository.refreshTokens.every((t) => t.revokedAt !== null)).toBe(true);
      expect(repository.recoveryCodes).toHaveLength(0);
    });

    it("soft-deletes the address book", async () => {
      repository.addresses = [];
      const { AddressesService } = await import("./addresses.service");
      const addresses = new AddressesService(repository);
      await addresses.create(customer.id, {
        type: "SHIPPING",
        firstName: "Valentina",
        lastName: "Restrepo",
        company: null,
        line1: "Calle 10 # 43-21",
        line2: null,
        city: "Medellín",
        region: "Antioquia",
        postalCode: null,
        countryCode: "CO",
        phone: null,
      });

      const result = await service.requestErasure(customer.id, {
        confirmEmail: customer.email,
      });

      expect(result.addressesErased).toBe(1);
      expect(await addresses.list(customer.id)).toEqual([]);
    });

    it("rejects a confirmation that does not match the account email", async () => {
      await expect(
        service.requestErasure(customer.id, { confirmEmail: "someone-else@example.com" }),
      ).rejects.toThrow(BadRequestException);

      const after = await service.getProfile(customer.id);
      expect(after.anonymisedAt).toBeNull();
    });

    it("refuses while an order is still being fulfilled", async () => {
      repository.orders = [
        {
          customerId: customer.id,
          orderNumber: "AK-2026-000002",
          status: "SHIPPED",
          currency: "EUR",
          grandTotal: 4999,
          refundedTotal: 0,
          placedAt: NOW,
          invoiceNumber: null,
        },
      ];

      // The retention basis is performance of a contract, which has not
      // finished — and erasing now destroys the delivery address for a parcel
      // that is physically in transit.
      await expect(
        service.requestErasure(customer.id, { confirmEmail: customer.email }),
      ).rejects.toThrow(ConflictException);
    });

    it("allows erasure once orders have reached a terminal state", async () => {
      repository.orders = [
        {
          customerId: customer.id,
          orderNumber: "AK-2026-000003",
          status: "DELIVERED",
          currency: "EUR",
          grandTotal: 4999,
          refundedTotal: 0,
          placedAt: NOW,
          invoiceNumber: "INV-3",
        },
      ];

      await expect(
        service.requestErasure(customer.id, { confirmEmail: customer.email }),
      ).resolves.toMatchObject({ ordersRetained: 1 });
    });

    it("is idempotent — a repeated request neither throws nor re-erases", async () => {
      const first = await service.requestErasure(customer.id, {
        confirmEmail: customer.email,
      });

      // The second call cannot supply the original email (it no longer exists),
      // which is exactly why the already-anonymised branch returns BEFORE the
      // confirmation check. Erasure is the operation a nervous user double-clicks.
      const second = await service.requestErasure(customer.id, {
        confirmEmail: "anything@example.com",
      });

      expect(second.anonymisedAt).toBe(first.anonymisedAt);
    });
  });
});
