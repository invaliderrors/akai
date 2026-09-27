import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { RecordNotFoundError } from "@akai/db";
import { AddressesService } from "./addresses.service";
import { UsersService } from "./users.service";
import type { Clock } from "./clock";
import {
  FakeUsersRepository,
  makeCustomerRow,
} from "./test-doubles/fake-users.repository";
import type { CreateAddressInput } from "./dto/users.dto";

/**
 * THE SECURITY TESTS.
 *
 * Everything here asks one question: can customer B reach customer A's data?
 * These are separated from the behavioural tests deliberately — a cross-tenant
 * leak is not "a failing test", it is the failure mode that matters most in a
 * customer dashboard, and it deserves a file whose name says so.
 *
 * Two properties are asserted throughout, not one:
 *
 *   1. The attacker does not get the data.
 *   2. The attacker gets 404, NOT 403.
 *
 * The second is easy to dismiss as pedantry and is not. A 403 means "this exists
 * but is not yours", which turns any of these endpoints into an oracle: iterate
 * ids, keep the ones that 403, and you have enumerated real records — their
 * count, their creation rate, and a target list. 404 for both "absent" and
 * "someone else's" makes the two indistinguishable.
 */

const FIXED_NOW = new Date("2026-07-20T12:00:00.000Z");
const fixedClock: Clock = { now: () => FIXED_NOW };

function addressInput(overrides: Partial<CreateAddressInput> = {}): CreateAddressInput {
  return {
    type: "SHIPPING",
    firstName: "Ana",
    lastName: "García",
    company: null,
    line1: "Calle Mayor 1",
    line2: null,
    city: "Madrid",
    region: null,
    postalCode: "28013",
    countryCode: "ES",
    phone: null,
    ...overrides,
  };
}

describe("cross-customer isolation", () => {
  let repository: FakeUsersRepository;
  let addresses: AddressesService;
  let users: UsersService;

  /** Two real customers. `victim` owns data; `attacker` holds a valid session. */
  const victim = makeCustomerRow({ email: "victim@example.com", firstName: "Victim" });
  const attacker = makeCustomerRow({ email: "attacker@example.com", firstName: "Mallory" });

  beforeEach(() => {
    repository = new FakeUsersRepository();
    repository.customers = [{ ...victim }, { ...attacker }];
    addresses = new AddressesService(repository);
    users = new UsersService(repository, fixedClock);
  });

  it("does not let a customer READ another customer's address", async () => {
    const owned = await addresses.create(victim.id, addressInput());

    // The attacker knows the exact id — the realistic case, since ids leak
    // through screenshots, support tickets and shared links.
    await expect(addresses.get(attacker.id, owned.id)).rejects.toThrow(
      RecordNotFoundError,
    );
  });

  it("does not let a customer UPDATE another customer's address", async () => {
    const owned = await addresses.create(victim.id, addressInput());

    await expect(
      addresses.update(attacker.id, owned.id, { city: "Barcelona" }),
    ).rejects.toThrow(RecordNotFoundError);

    // The record is not merely un-returned — it is UNCHANGED. A test that only
    // asserted the throw would pass even if the write had landed before the
    // ownership check rejected the read-back.
    const stillOwned = await addresses.get(victim.id, owned.id);
    expect(stillOwned.city).toBe("Madrid");
  });

  it("does not let a customer DELETE another customer's address", async () => {
    const owned = await addresses.create(victim.id, addressInput());

    await expect(addresses.remove(attacker.id, owned.id)).rejects.toThrow(
      RecordNotFoundError,
    );

    const survivors = await addresses.list(victim.id);
    expect(survivors).toHaveLength(1);
  });

  it("does not leak another customer's addresses through the list endpoint", async () => {
    await addresses.create(victim.id, addressInput());
    await addresses.create(victim.id, addressInput({ type: "BILLING" }));

    expect(await addresses.list(attacker.id)).toEqual([]);
  });

  it("reports a foreign record as NOT_FOUND, never FORBIDDEN", async () => {
    const owned = await addresses.create(victim.id, addressInput());

    // RecordNotFoundError is mapped to 404 by AllExceptionsFilter. Asserting the
    // error TYPE here pins the status without needing an HTTP round trip.
    const foreign = addresses.get(attacker.id, owned.id).catch((error: unknown) => error);
    const missing = addresses
      .get(attacker.id, "00000000-0000-4000-8000-000000000000")
      .catch((error: unknown) => error);

    // A real id belonging to someone else and an id that does not exist must be
    // indistinguishable to the caller.
    expect(await foreign).toBeInstanceOf(RecordNotFoundError);
    expect(await missing).toBeInstanceOf(RecordNotFoundError);
    expect(String(await foreign)).toBe(String(await missing));
  });

  it("scopes the GDPR export to the caller and nobody else", async () => {
    await addresses.create(victim.id, addressInput());
    repository.orders = [
      {
        customerId: victim.id,
        orderNumber: "AK-2026-000001",
        status: "DELIVERED",
        currency: "EUR",
        grandTotal: 4999,
        refundedTotal: 0,
        placedAt: new Date("2026-05-01T00:00:00.000Z"),
        invoiceNumber: "INV-1",
      },
    ];
    repository.emails = [
      { recipient: victim.email, templateKey: "order-confirmation", status: "SENT", sentAt: FIXED_NOW },
    ];

    const attackerExport = await users.exportPersonalData(attacker.id);

    expect(attackerExport.profile.id).toBe(attacker.id);
    expect(attackerExport.addresses).toEqual([]);
    expect(attackerExport.orders).toEqual([]);
    // Email history is keyed by ADDRESS rather than customer id, which makes it
    // the likeliest place for a scoping mistake to hide.
    expect(attackerExport.emails).toEqual([]);
  });

  it("erases only the calling customer's account", async () => {
    await addresses.create(victim.id, addressInput());
    await addresses.create(attacker.id, addressInput());

    await users.requestErasure(attacker.id, { confirmEmail: attacker.email });

    const victimAfter = await users.getProfile(victim.id);
    expect(victimAfter.anonymisedAt).toBeNull();
    expect(victimAfter.email).toBe(victim.email);
    expect(await addresses.list(victim.id)).toHaveLength(1);
  });

  it("never lets a profile update reach another customer's row", async () => {
    await users.updateProfile(attacker.id, { firstName: "Renamed" });

    const victimAfter = await users.getProfile(victim.id);
    expect(victimAfter.firstName).toBe("Victim");
  });
});

/**
 * The mapper is part of the security boundary, so it gets a boundary test.
 *
 * `CustomerRow` does not carry `passwordHash` or `totpSecret` at all, and the
 * `.strict()` contract schema would throw on an unexpected key. This asserts the
 * outcome of that design rather than trusting it.
 */
describe("profile serialisation", () => {
  it("exposes no credential material", async () => {
    const repository = new FakeUsersRepository();
    const customer = makeCustomerRow({ totpEnabledAt: new Date() });
    repository.customers = [customer];
    const users = new UsersService(repository, fixedClock);

    const profile = await users.getProfile(customer.id);
    const keys = Object.keys(profile);

    expect(keys).not.toContain("passwordHash");
    expect(keys).not.toContain("totpSecret");
    expect(keys).not.toContain("recoveryCodes");
    expect(keys).not.toContain("failedLoginCount");
    // 2FA state is reported as a boolean — enrolment is knowable, the secret is not.
    expect(profile.twoFactorEnabled).toBe(true);
  });
});
