import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { Address, AddressType } from "@akai/contracts";
import { assertFound } from "@akai/db";
import type { CreateAddressInput, UpdateAddressInput } from "./dto/users.dto";
import { toAddress } from "./users.mapper";
import {
  USERS_REPOSITORY,
  type AddressPatch,
  type AddressRow,
  type UsersDataAccess,
  type UsersRepository,
} from "./users.repository";

/**
 * The address book.
 *
 * THE INVARIANT this service exists to hold: for each customer and each address
 * type, among non-deleted addresses there is exactly one default — or none only
 * when the customer has no address of that type at all.
 *
 * That invariant is not expressible in the current Prisma schema (there is no
 * partial unique index on `(customerId, type, isDefault) WHERE isDefault AND
 * deletedAt IS NULL`), so it is enforced here, inside transactions. A database
 * constraint would be strictly better and is listed in followUps; until it
 * exists, `reconcileDefaults` is the only thing standing between a customer and
 * a checkout page that has to pick arbitrarily between two "default" addresses.
 *
 * Every method takes `customerId` from `@CurrentUser()` and passes it to
 * repository methods that require it. There is no unscoped lookup available.
 */
@Injectable()
export class AddressesService {
  constructor(
    @Inject(USERS_REPOSITORY) private readonly repository: UsersRepository,
  ) {}

  async list(customerId: string): Promise<readonly Address[]> {
    const rows = await this.repository.listAddresses(customerId);
    return rows.map(toAddress);
  }

  async get(customerId: string, addressId: string): Promise<Address> {
    return toAddress(await this.requireOwned(this.repository, addressId, customerId));
  }

  /**
   * Create an address.
   *
   * The first address of a type becomes the default automatically, whatever the
   * request said. A customer whose only shipping address is not their default
   * shipping address is a checkout bug waiting to happen, and asking them to
   * tick a box to fix it is not a real solution.
   */
  async create(customerId: string, input: CreateAddressInput): Promise<Address> {
    return this.repository.transaction(async (tx) => {
      const existingOfType = await tx.countAddressesOfType(customerId, input.type);
      const shouldBeDefault = input.isDefault === true || existingOfType === 0;

      // Demote incumbents BEFORE inserting, inside the transaction, so there is
      // no window in which two rows both claim the default.
      if (shouldBeDefault) {
        await tx.clearDefaultOfType(customerId, input.type);
      }

      const created = await tx.insertAddress(customerId, {
        type: input.type,
        firstName: input.firstName,
        lastName: input.lastName,
        company: input.company,
        line1: input.line1,
        line2: input.line2,
        city: input.city,
        region: input.region,
        postalCode: input.postalCode,
        countryCode: input.countryCode,
        phone: input.phone,
        isDefault: shouldBeDefault,
      });

      return toAddress(created);
    });
  }

  /**
   * Update an address.
   *
   * The subtle case is a TYPE CHANGE: flipping the default shipping address to
   * BILLING removes the default from the shipping set. Both the old and the new
   * type are therefore reconciled, which is why the affected types are collected
   * rather than assuming one.
   */
  async update(
    customerId: string,
    addressId: string,
    input: UpdateAddressInput,
  ): Promise<Address> {
    return this.repository.transaction(async (tx) => {
      const existing = await this.requireOwned(tx, addressId, customerId);

      // Refused rather than honoured. Clearing the flag on the sole default
      // leaves the type with no default at all; the coherent way to express
      // "not this one" is to set a different address as the default, which
      // demotes this one as a side effect.
      if (input.isDefault === false && existing.isDefault) {
        throw new ConflictException(
          "Set another address as the default instead of unsetting this one",
        );
      }

      const nextType: AddressType = input.type ?? existing.type;

      const patch: AddressPatch = {
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.line1 !== undefined ? { line1: input.line1 } : {}),
        ...(input.line2 !== undefined ? { line2: input.line2 } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
      };

      if (input.isDefault === true) {
        await tx.clearDefaultOfType(customerId, nextType);
      }

      // Scoped update: returns null when the row is not the caller's, which is
      // belt-and-braces given requireOwned already ran — the check costs one
      // predicate and removes any reliance on the earlier read still holding.
      // The result is discarded rather than returned: reconciliation below may
      // change this row's default flag, so it is re-read once at the end.
      assertFound(await tx.updateAddressOwned(addressId, customerId, patch), "Address");

      if (input.isDefault === true) {
        await tx.setAddressDefault(addressId, customerId, true);
      }

      const affectedTypes = new Set<AddressType>([existing.type, nextType]);
      for (const type of affectedTypes) {
        await this.reconcileDefaults(tx, customerId, type);
      }

      return toAddress(assertFound(
        await tx.findAddressOwned(addressId, customerId),
        "Address",
      ));
    });
  }

  /**
   * Soft-delete an address.
   *
   * Soft, not hard, because `deletedAt` exists on the model and because an
   * address may still be referenced by support workflows. Orders are unaffected
   * either way — they snapshot addresses into their own columns rather than
   * holding an FK (spec §13), so deleting an address never rewrites history.
   */
  async remove(customerId: string, addressId: string): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const removed = assertFound(
        await tx.softDeleteAddressOwned(addressId, customerId),
        "Address",
      );

      // Deleting the default must promote a survivor, or the customer silently
      // has no default shipping address and checkout has nothing to preselect.
      if (removed.isDefault) {
        await this.reconcileDefaults(tx, customerId, removed.type);
      }
    });
  }

  /**
   * Restore "exactly one default among the live addresses of this type".
   *
   * Handles both directions of drift: none (promote the newest) and more than
   * one (keep the newest, demote the rest). The >1 branch should be unreachable
   * given the writes above, which is precisely why it is handled rather than
   * asserted — the cost of converging is one query, and the cost of trusting the
   * assumption is an ambiguous checkout.
   */
  private async reconcileDefaults(
    tx: UsersDataAccess,
    customerId: string,
    type: AddressType,
  ): Promise<void> {
    const addresses = await tx.listAddressesOfType(customerId, type);
    if (addresses.length === 0) {
      return;
    }

    const defaults = addresses.filter((address) => address.isDefault);

    if (defaults.length === 1) {
      return;
    }

    if (defaults.length === 0) {
      const [newest] = addresses;
      if (newest !== undefined) {
        await tx.setAddressDefault(newest.id, customerId, true);
      }
      return;
    }

    const [keep, ...demote] = defaults;
    if (keep === undefined) {
      return;
    }
    for (const address of demote) {
      await tx.setAddressDefault(address.id, customerId, false);
    }
  }

  /**
   * Resolve an address by (id AND customerId).
   *
   * A miss raises RecordNotFoundError, which the global filter renders as 404 —
   * NOT 403. A 403 would confirm that the id exists and belongs to someone,
   * turning this endpoint into an oracle for enumerating other customers' rows
   * (see libs/db/ownership.ts).
   */
  private async requireOwned(
    tx: UsersDataAccess,
    addressId: string,
    customerId: string,
  ): Promise<AddressRow> {
    return assertFound(await tx.findAddressOwned(addressId, customerId), "Address");
  }
}
