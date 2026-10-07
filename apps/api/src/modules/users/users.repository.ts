import type { AddressType, Locale, Role } from "@akai/contracts";

/**
 * The data surface of UsersModule, declared as a port.
 *
 * Why a port rather than injecting PrismaService into the services directly:
 *
 * 1. It ENUMERATES the tables this module may touch. A future change that
 *    starts reading `payment` from a profile service has to add a method here
 *    first, which is a reviewable event rather than an invisible one.
 *
 * 2. Every ownership-scoped method takes `customerId` as a REQUIRED parameter —
 *    there is no `findAddress(id)` to reach for. The IDOR-safe call is the only
 *    call available, which is a stronger guarantee than remembering to add a
 *    filter (libs/db/ownership.ts makes the same argument).
 *
 * 3. It makes the service logic unit-testable against an in-memory fake that
 *    enforces the same scoping the SQL does, with no database and no mocks that
 *    drift from the real signatures.
 *
 * Row types are declared narrowly here rather than reusing Prisma's generated
 * model types, deliberately: `passwordHash`, `totpSecret` and the lockout
 * counters are NOT on `CustomerRow`, so no service in this module can read them
 * and no mapper can leak them, whatever the select clause happens to return.
 */

export const USERS_REPOSITORY = "akai:users-repository";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface CustomerRow {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly role: Role;
  readonly preferredLocale: Locale;
  /** Non-null once TOTP is enrolled. The SECRET itself is not exposed here. */
  readonly totpEnabledAt: Date | null;
  readonly marketingConsentAt: Date | null;
  readonly anonymisedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AddressRow {
  readonly id: string;
  readonly customerId: string;
  readonly type: AddressType;
  readonly firstName: string;
  readonly lastName: string;
  readonly company: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string | null;
  readonly countryCode: string;
  readonly phone: string | null;
  readonly isDefault: boolean;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrderExportRow {
  readonly orderNumber: string;
  readonly status: string;
  readonly currency: string;
  /** Integer minor units, straight from the Int column. Never a Decimal. */
  readonly grandTotal: number;
  readonly placedAt: Date;
  readonly invoiceNumber: string | null;
}

export interface ConsentExportRow {
  readonly kind: string;
  readonly version: string;
  readonly granted: boolean;
  readonly createdAt: Date;
}

export interface EmailExportRow {
  readonly templateKey: string;
  readonly status: string;
  readonly sentAt: Date | null;
}

export interface SessionExportRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * Per-customer order aggregates for the admin list.
 *
 * `lifetimeValueMinor` is a BIGINT, not a number, and that is not defensive
 * styling. Spec §4: money columns are 32-bit `Int`, so a SUM over them overflows
 * in Postgres before it ever reaches JavaScript. The SQL casts to bigint, the
 * driver hands back a JS BigInt, and the conversion to a safe number happens
 * once, explicitly, in the service — where it can throw instead of silently
 * wrapping.
 */
export interface CustomerOrderStats {
  readonly customerId: string;
  readonly orderCount: number;
  readonly lifetimeValueMinor: bigint;
  readonly lastOrderAt: Date | null;
}

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------

/**
 * Optional properties are written `?: T | undefined` throughout.
 *
 * `exactOptionalPropertyTypes` is on, under which `{ a?: string }` and
 * `{ a?: string | undefined }` are different types and a zod `.partial()` output
 * (which produces the latter) is not assignable to the former. Spelling it out
 * keeps these payloads assignable from parsed DTOs without a cast.
 */
export interface ProfilePatch {
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly preferredLocale?: Locale | undefined;
}

export interface AddressInsert {
  readonly type: AddressType;
  readonly firstName: string;
  readonly lastName: string;
  readonly company: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string | null;
  readonly countryCode: string;
  readonly phone: string | null;
  readonly isDefault: boolean;
}

export interface AddressPatch {
  readonly type?: AddressType | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly company?: string | null | undefined;
  readonly line1?: string | undefined;
  readonly line2?: string | null | undefined;
  readonly city?: string | undefined;
  readonly region?: string | undefined;
  readonly postalCode?: string | null | undefined;
  readonly countryCode?: string | undefined;
  readonly phone?: string | null | undefined;
}

export interface CustomerListFilter {
  readonly emailContains?: string | undefined;
  readonly role?: Role | undefined;
  readonly anonymised?: boolean | undefined;
  readonly createdAfter?: Date | undefined;
  readonly createdBefore?: Date | undefined;
  readonly cursorId?: string | undefined;
  /** Callers pass limit + 1 and use the extra row to detect `hasMore`. */
  readonly take: number;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Operations available both standalone and inside a transaction.
 *
 * Splitting this from `UsersRepository` is what lets the SERVICES own the
 * multi-step logic (default-address reconciliation, erasure) while the
 * repository owns only atomicity. The alternative — pushing that logic into the
 * repository so it can be transactional — would make it reachable only through a
 * real database, and the rules worth testing hardest are exactly those.
 */
export interface UsersDataAccess {
  // --- profile ---
  findCustomerById(id: string): Promise<CustomerRow | null>;
  updateCustomerProfile(id: string, patch: ProfilePatch): Promise<CustomerRow>;

  // --- address book (every method scoped by customerId) ---
  listAddresses(customerId: string): Promise<readonly AddressRow[]>;
  listAddressesOfType(
    customerId: string,
    type: AddressType,
  ): Promise<readonly AddressRow[]>;
  findAddressOwned(id: string, customerId: string): Promise<AddressRow | null>;
  countAddressesOfType(customerId: string, type: AddressType): Promise<number>;
  clearDefaultOfType(customerId: string, type: AddressType): Promise<void>;
  setAddressDefault(id: string, customerId: string, isDefault: boolean): Promise<void>;
  insertAddress(customerId: string, data: AddressInsert): Promise<AddressRow>;
  updateAddressOwned(
    id: string,
    customerId: string,
    patch: AddressPatch,
  ): Promise<AddressRow | null>;
  softDeleteAddressOwned(id: string, customerId: string): Promise<AddressRow | null>;
  softDeleteAllAddresses(customerId: string): Promise<number>;

  // --- GDPR export ---
  listOrdersForExport(customerId: string): Promise<readonly OrderExportRow[]>;
  listConsentRecords(customerId: string): Promise<readonly ConsentExportRow[]>;
  listEmailEvents(email: string): Promise<readonly EmailExportRow[]>;
  listSessions(customerId: string): Promise<readonly SessionExportRow[]>;

  // --- erasure ---
  /** Orders in a state that is still being performed; blocks erasure. */
  countOpenOrders(customerId: string): Promise<number>;
  countOrders(customerId: string): Promise<number>;
  anonymiseCustomer(
    id: string,
    tombstoneEmail: string,
    anonymisedAt: Date,
  ): Promise<CustomerRow>;
  revokeAllSessions(customerId: string, revokedAt: Date): Promise<number>;
  revokeAllRefreshTokens(customerId: string, revokedAt: Date): Promise<number>;
  deleteRecoveryCodes(customerId: string): Promise<number>;

  // --- admin ---
  listCustomers(filter: CustomerListFilter): Promise<readonly CustomerRow[]>;
  aggregateOrderStats(
    customerIds: readonly string[],
  ): Promise<readonly CustomerOrderStats[]>;
}

export interface UsersRepository extends UsersDataAccess {
  /**
   * Run `work` in a single database transaction.
   *
   * Address-default reconciliation and erasure are both multi-statement
   * invariants: "exactly one default per type" and "the account is tombstoned
   * AND its sessions are dead" are each false at some intermediate point. A
   * crash between statements without a transaction leaves a customer with two
   * default shipping addresses, or — far worse — an anonymised profile whose
   * sessions still authenticate.
   */
  transaction<T>(work: (tx: UsersDataAccess) => Promise<T>): Promise<T>;
}
