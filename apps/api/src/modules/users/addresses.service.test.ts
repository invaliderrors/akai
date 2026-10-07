import "reflect-metadata";
import { ConflictException } from "@nestjs/common";
import { RecordNotFoundError } from "@akai/db";
import { beforeEach, describe, expect, it } from "vitest";
import type { Address, AddressType } from "@akai/contracts";
import { AddressesService } from "./addresses.service";
import type { CreateAddressInput } from "./dto/users.dto";
import {
  FakeUsersRepository,
  makeCustomerRow,
} from "./test-doubles/fake-users.repository";

const owner = makeCustomerRow();

function addressInput(overrides: Partial<CreateAddressInput> = {}): CreateAddressInput {
  return {
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
    ...overrides,
  };
}

/**
 * Assert the module's central invariant: for a given type, exactly one default
 * among live addresses — or none only when there are none at all.
 *
 * Written as a helper and called after every mutation, because the invariant is
 * global to the address book. Checking only the address a test happened to touch
 * is how "setting a new default" ships without demoting the old one.
 */
async function expectExactlyOneDefault(
  service: AddressesService,
  customerId: string,
  type: AddressType,
): Promise<Address | null> {
  const all = await service.list(customerId);
  const ofType = all.filter((address) => address.type === type);
  const defaults = ofType.filter((address) => address.isDefault);

  if (ofType.length === 0) {
    expect(defaults).toHaveLength(0);
    return null;
  }
  expect(defaults).toHaveLength(1);
  return defaults[0] ?? null;
}

describe("AddressesService", () => {
  let repository: FakeUsersRepository;
  let service: AddressesService;

  beforeEach(() => {
    repository = new FakeUsersRepository();
    repository.customers = [{ ...owner }];
    service = new AddressesService(repository);
  });

  describe("defaults", () => {
    it("makes the first address of a type the default even when not asked", async () => {
      const created = await service.create(owner.id, addressInput());
      expect(created.isDefault).toBe(true);
    });

    it("does not make a second address default by accident", async () => {
      await service.create(owner.id, addressInput());
      const second = await service.create(owner.id, addressInput({ line1: "Gran Vía 2" }));

      expect(second.isDefault).toBe(false);
      await expectExactlyOneDefault(service, owner.id, "SHIPPING");
    });

    it("demotes the incumbent when a new address is created as default", async () => {
      const first = await service.create(owner.id, addressInput());
      const second = await service.create(
        owner.id,
        addressInput({ line1: "Gran Vía 2", isDefault: true }),
      );

      const current = await expectExactlyOneDefault(service, owner.id, "SHIPPING");
      expect(current?.id).toBe(second.id);
      expect(current?.id).not.toBe(first.id);
    });

    /**
     * SHIPPING and BILLING keep INDEPENDENT defaults. Sharing one would mean
     * setting a billing address silently changes where the parcel goes.
     */
    it("keeps shipping and billing defaults independent", async () => {
      const shipping = await service.create(owner.id, addressInput({ type: "SHIPPING" }));
      const billing = await service.create(owner.id, addressInput({ type: "BILLING" }));

      expect(shipping.isDefault).toBe(true);
      expect(billing.isDefault).toBe(true);

      const newBilling = await service.create(
        owner.id,
        addressInput({ type: "BILLING", isDefault: true, line1: "Otra 3" }),
      );

      const defaultShipping = await expectExactlyOneDefault(service, owner.id, "SHIPPING");
      const defaultBilling = await expectExactlyOneDefault(service, owner.id, "BILLING");

      expect(defaultShipping?.id).toBe(shipping.id);
      expect(defaultBilling?.id).toBe(newBilling.id);
    });

    it("promotes a survivor when the default is deleted", async () => {
      const first = await service.create(owner.id, addressInput());
      const second = await service.create(owner.id, addressInput({ line1: "Gran Vía 2" }));

      await service.remove(owner.id, first.id);

      // Without promotion the customer would have one address and no default,
      // leaving checkout with nothing to preselect.
      const current = await expectExactlyOneDefault(service, owner.id, "SHIPPING");
      expect(current?.id).toBe(second.id);
    });

    it("leaves no default when the last address of a type is deleted", async () => {
      const only = await service.create(owner.id, addressInput());
      await service.remove(owner.id, only.id);

      expect(await expectExactlyOneDefault(service, owner.id, "SHIPPING")).toBeNull();
      expect(await service.list(owner.id)).toEqual([]);
    });

    it("refuses to unset the sole default rather than leaving none", async () => {
      const only = await service.create(owner.id, addressInput());

      await expect(
        service.update(owner.id, only.id, { isDefault: false }),
      ).rejects.toThrow(ConflictException);

      await expectExactlyOneDefault(service, owner.id, "SHIPPING");
    });

    it("promotes the default via an update and demotes the previous one", async () => {
      const first = await service.create(owner.id, addressInput());
      const second = await service.create(owner.id, addressInput({ line1: "Gran Vía 2" }));

      const promoted = await service.update(owner.id, second.id, { isDefault: true });

      expect(promoted.isDefault).toBe(true);
      const current = await expectExactlyOneDefault(service, owner.id, "SHIPPING");
      expect(current?.id).toBe(second.id);
      expect(current?.id).not.toBe(first.id);
    });

    /**
     * The awkward case. Moving the default SHIPPING address to BILLING strips
     * the shipping set of its default; both types must be reconciled, which is
     * why the service collects the affected types rather than assuming one.
     */
    it("reconciles both types when an address changes type", async () => {
      const shipping = await service.create(owner.id, addressInput({ type: "SHIPPING" }));
      const otherShipping = await service.create(
        owner.id,
        addressInput({ type: "SHIPPING", line1: "Gran Vía 2" }),
      );

      await service.update(owner.id, shipping.id, { type: "BILLING" });

      const defaultShipping = await expectExactlyOneDefault(service, owner.id, "SHIPPING");
      const defaultBilling = await expectExactlyOneDefault(service, owner.id, "BILLING");

      expect(defaultShipping?.id).toBe(otherShipping.id);
      // The moved address is the only BILLING entry, so it becomes that default.
      expect(defaultBilling?.id).toBe(shipping.id);
    });
  });

  describe("CRUD", () => {
    it("returns the created address in the contract shape", async () => {
      const created = await service.create(
        owner.id,
        addressInput({ company: "Akai SAS", phone: "3001234567" }),
      );

      expect(created.customerId).toBe(owner.id);
      expect(created.company).toBe("Akai SAS");
      expect(created.countryCode).toBe("CO");
      // Serialised as ISO strings, never Date objects — the wire format is JSON.
      expect(typeof created.createdAt).toBe("string");
    });

    it("applies a partial update without clobbering untouched fields", async () => {
      const created = await service.create(owner.id, addressInput({ company: "Akai SL" }));

      const updated = await service.update(owner.id, created.id, { city: "Barcelona" });

      expect(updated.city).toBe("Barcelona");
      expect(updated.company).toBe("Akai SL");
      expect(updated.line1).toBe("Calle 10 # 43-21");
    });

    it("distinguishes an explicit null from an omitted field", async () => {
      const created = await service.create(owner.id, addressInput({ company: "Akai SL" }));

      const cleared = await service.update(owner.id, created.id, { company: null });
      expect(cleared.company).toBeNull();

      const untouched = await service.update(owner.id, created.id, { city: "Sevilla" });
      expect(untouched.company).toBeNull();
    });

    it("hides soft-deleted addresses from reads", async () => {
      const created = await service.create(owner.id, addressInput());
      await service.remove(owner.id, created.id);

      await expect(service.get(owner.id, created.id)).rejects.toThrow(RecordNotFoundError);
      expect(await service.list(owner.id)).toEqual([]);
    });

    it("treats a second delete as not-found rather than succeeding twice", async () => {
      const created = await service.create(owner.id, addressInput());
      await service.remove(owner.id, created.id);

      await expect(service.remove(owner.id, created.id)).rejects.toThrow(
        RecordNotFoundError,
      );
    });
  });
});
