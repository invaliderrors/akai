import {
  addressSchema,
  customerSchema,
  type Address,
  type Customer,
} from "@akai/contracts";
import type { AddressRow, CustomerRow } from "./users.repository";

/**
 * Row → wire mappers.
 *
 * Two rules, both load-bearing:
 *
 * 1. Fields are listed EXPLICITLY. Never `{ ...row }`. A spread turns every
 *    future schema column into an automatically-published API field, which is
 *    how password hashes and TOTP secrets get shipped — the change that leaks
 *    them is a migration, and nobody reviews a migration for response shape.
 *
 * 2. The result is `schema.parse(...)`, not a cast. The contract schemas are
 *    `.strict()`, so a key that should not be in a response makes this THROW at
 *    the point of construction rather than serialising quietly. It also converts
 *    Date → ISO string under `isoDateTimeSchema` validation, so a malformed
 *    timestamp cannot reach a client either.
 */

export function toCustomer(row: CustomerRow): Customer {
  return customerSchema.parse({
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    role: row.role,
    // Derived, never stored twice. `totpSecret` is not on CustomerRow at all,
    // so "is 2FA on" cannot be answered by leaking the secret's presence.
    twoFactorEnabled: row.totpEnabledAt !== null,
    anonymisedAt: row.anonymisedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toAddress(row: AddressRow): Address {
  return addressSchema.parse({
    id: row.id,
    customerId: row.customerId,
    type: row.type,
    firstName: row.firstName,
    lastName: row.lastName,
    company: row.company,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    phone: row.phone,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
