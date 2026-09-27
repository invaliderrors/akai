import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@akai/db";
import { PrismaService } from "../prisma/prisma.service";
import type {
  AddressInsert,
  AddressPatch,
  AddressRow,
  ConsentExportRow,
  CustomerListFilter,
  CustomerOrderStats,
  CustomerRow,
  EmailExportRow,
  OrderExportRow,
  ProfilePatch,
  SessionExportRow,
  UsersDataAccess,
  UsersRepository,
} from "./users.repository";
import type { AddressType } from "@akai/contracts";

/**
 * Prisma implementation of the UsersModule port.
 *
 * This file is deliberately logic-free: it translates port calls into queries
 * and nothing else. Every rule worth testing (default reconciliation, erasure
 * ordering, overflow handling) lives in the services, where it is unit-testable
 * without a database. What CANNOT be unit-tested is whether these queries
 * actually scope the way they claim to — that is api-e2e's job against real SQL.
 */

/**
 * The Prisma surface this module uses.
 *
 * Narrowed with `Pick` rather than taking the whole client so the module's table
 * access is declared rather than ambient. `Prisma.TransactionClient` satisfies
 * it, which is what lets the same code run inside and outside a transaction.
 */
type UsersPrismaClient = Pick<
  PrismaService,
  | "customer"
  | "address"
  | "order"
  | "consentRecord"
  | "emailEvent"
  | "session"
  | "refreshToken"
  | "recoveryCode"
  | "$queryRaw"
>;

/**
 * Columns exposed to the application.
 *
 * `passwordHash`, `totpSecret`, `failedLoginCount` and `lockedUntil` are
 * deliberately absent. Selecting them "just in case" would put credential
 * material in the same object the mappers walk, and the only thing then keeping
 * it out of a response is the mapper remembering to skip it.
 */
const CUSTOMER_SELECT = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  preferredLocale: true,
  totpEnabledAt: true,
  marketingConsentAt: true,
  anonymisedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ADDRESS_SELECT = {
  id: true,
  customerId: true,
  type: true,
  firstName: true,
  lastName: true,
  company: true,
  line1: true,
  line2: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  phone: true,
  isDefault: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Statuses that represent money actually taken.
 *
 * A PENDING order is an abandoned cart, not revenue, and counting it would
 * inflate every lifetime-value figure on the admin screen.
 */
const REVENUE_STATUSES = [
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;

/**
 * Statuses where the store still owes the customer something.
 *
 * Erasure is refused while any of these are open: the retention basis for the
 * address is performance of a contract, which has not finished.
 */
const OPEN_ORDER_STATUSES = [
  "PENDING",
  "AWAITING_PAYMENT",
  "PAID",
  "FULFILLING",
  "SHIPPED",
] as const;

/**
 * Raw-query results are validated, not asserted.
 *
 * `$queryRaw<T>` is a promise about the shape, not a check of it — the generic
 * is applied to whatever the driver returns. Money is involved here, so the
 * bigint-ness of the aggregate is verified rather than assumed; a driver or
 * cast change that started returning strings would otherwise surface as
 * `Number("123") + Number("456")` working fine until it silently didn't.
 */
const orderStatsRowSchema = z
  .object({
    customer_id: z.string(),
    order_count: z.bigint(),
    lifetime_value: z.bigint().nullable(),
    last_order_at: z.date().nullable(),
  })
  .strict();

/**
 * EXPORTED so the raw-SQL half can be exercised against a REAL Postgres.
 *
 * It takes the narrow `UsersPrismaClient` rather than the Nest-managed
 * `PrismaService`, which is what lets an integration test hand it a plain client
 * from a throwaway container. `aggregateOrderStats` is hand-written SQL, and a
 * fake client validates none of it — a column name that does not exist is only
 * ever caught by a server.
 */
export class PrismaUsersDataAccess implements UsersDataAccess {
  constructor(protected readonly client: UsersPrismaClient) {}

  // --- profile -------------------------------------------------------------

  async findCustomerById(id: string): Promise<CustomerRow | null> {
    return this.client.customer.findUnique({
      where: { id },
      select: CUSTOMER_SELECT,
    });
  }

  async updateCustomerProfile(id: string, patch: ProfilePatch): Promise<CustomerRow> {
    return this.client.customer.update({
      where: { id },
      data: {
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.preferredLocale !== undefined
          ? { preferredLocale: patch.preferredLocale }
          : {}),
      },
      select: CUSTOMER_SELECT,
    });
  }

  // --- address book --------------------------------------------------------

  async listAddresses(customerId: string): Promise<readonly AddressRow[]> {
    return this.client.address.findMany({
      where: { customerId, deletedAt: null },
      orderBy: [{ type: "asc" }, { isDefault: "desc" }, { createdAt: "desc" }],
      select: ADDRESS_SELECT,
    });
  }

  /** Newest first — `reconcileDefaults` promotes the head of this list. */
  async listAddressesOfType(
    customerId: string,
    type: AddressType,
  ): Promise<readonly AddressRow[]> {
    return this.client.address.findMany({
      where: { customerId, type, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: ADDRESS_SELECT,
    });
  }

  /** (id AND customerId) — never id alone. See libs/db/ownership.ts. */
  async findAddressOwned(id: string, customerId: string): Promise<AddressRow | null> {
    return this.client.address.findFirst({
      where: { id, customerId, deletedAt: null },
      select: ADDRESS_SELECT,
    });
  }

  async countAddressesOfType(customerId: string, type: AddressType): Promise<number> {
    return this.client.address.count({
      where: { customerId, type, deletedAt: null },
    });
  }

  async clearDefaultOfType(customerId: string, type: AddressType): Promise<void> {
    await this.client.address.updateMany({
      where: { customerId, type, deletedAt: null, isDefault: true },
      data: { isDefault: false },
    });
  }

  async setAddressDefault(
    id: string,
    customerId: string,
    isDefault: boolean,
  ): Promise<void> {
    await this.client.address.updateMany({
      where: { id, customerId, deletedAt: null },
      data: { isDefault },
    });
  }

  async insertAddress(customerId: string, data: AddressInsert): Promise<AddressRow> {
    return this.client.address.create({
      data: {
        customerId,
        type: data.type,
        firstName: data.firstName,
        lastName: data.lastName,
        company: data.company,
        line1: data.line1,
        line2: data.line2,
        city: data.city,
        region: data.region,
        postalCode: data.postalCode,
        countryCode: data.countryCode,
        phone: data.phone,
        isDefault: data.isDefault,
      },
      select: ADDRESS_SELECT,
    });
  }

  /**
   * The WRITE itself is ownership-scoped (`updateMany` with customerId), not
   * just a preceding read. A read-then-update-by-id would be correct only until
   * something interleaved between the two statements.
   */
  async updateAddressOwned(
    id: string,
    customerId: string,
    patch: AddressPatch,
  ): Promise<AddressRow | null> {
    const result = await this.client.address.updateMany({
      where: { id, customerId, deletedAt: null },
      data: {
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.company !== undefined ? { company: patch.company } : {}),
        ...(patch.line1 !== undefined ? { line1: patch.line1 } : {}),
        ...(patch.line2 !== undefined ? { line2: patch.line2 } : {}),
        ...(patch.city !== undefined ? { city: patch.city } : {}),
        ...(patch.region !== undefined ? { region: patch.region } : {}),
        ...(patch.postalCode !== undefined ? { postalCode: patch.postalCode } : {}),
        ...(patch.countryCode !== undefined ? { countryCode: patch.countryCode } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      },
    });

    if (result.count === 0) {
      return null;
    }

    return this.findAddressOwned(id, customerId);
  }

  /** Returns the PRE-deletion row: the caller needs its type and default flag. */
  async softDeleteAddressOwned(
    id: string,
    customerId: string,
  ): Promise<AddressRow | null> {
    const existing = await this.findAddressOwned(id, customerId);
    if (existing === null) {
      return null;
    }

    const result = await this.client.address.updateMany({
      where: { id, customerId, deletedAt: null },
      data: { deletedAt: new Date(), isDefault: false },
    });

    return result.count === 0 ? null : existing;
  }

  async softDeleteAllAddresses(customerId: string): Promise<number> {
    const result = await this.client.address.updateMany({
      where: { customerId, deletedAt: null },
      data: { deletedAt: new Date(), isDefault: false },
    });
    return result.count;
  }

  // --- GDPR export ---------------------------------------------------------

  async listOrdersForExport(customerId: string): Promise<readonly OrderExportRow[]> {
    return this.client.order.findMany({
      where: { customerId },
      orderBy: { placedAt: "desc" },
      select: {
        orderNumber: true,
        status: true,
        currency: true,
        grandTotal: true,
        placedAt: true,
        invoiceNumber: true,
      },
    });
  }

  async listConsentRecords(customerId: string): Promise<readonly ConsentExportRow[]> {
    return this.client.consentRecord.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      select: { kind: true, version: true, granted: true, createdAt: true },
    });
  }

  /**
   * Keyed by EMAIL because email_event has no customerId — it must record sends
   * to guest checkouts too. The caller passes the owner's stored address, never
   * one supplied by the request.
   */
  async listEmailEvents(email: string): Promise<readonly EmailExportRow[]> {
    return this.client.emailEvent.findMany({
      where: { recipient: email },
      orderBy: { createdAt: "desc" },
      select: { templateKey: true, status: true, sentAt: true },
    });
  }

  async listSessions(customerId: string): Promise<readonly SessionExportRow[]> {
    return this.client.session.findMany({
      where: { customerId, revokedAt: null },
      orderBy: { lastSeenAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });
  }

  // --- erasure -------------------------------------------------------------

  async countOpenOrders(customerId: string): Promise<number> {
    return this.client.order.count({
      where: { customerId, status: { in: [...OPEN_ORDER_STATUSES] } },
    });
  }

  async countOrders(customerId: string): Promise<number> {
    return this.client.order.count({ where: { customerId } });
  }

  /**
   * Anonymise in place. Note it is an UPDATE, never a delete: the customer row
   * survives so orders keep a stable (now meaningless) foreign key and invoice
   * retention is unaffected.
   */
  async anonymiseCustomer(
    id: string,
    tombstoneEmail: string,
    anonymisedAt: Date,
  ): Promise<CustomerRow> {
    return this.client.customer.update({
      where: { id },
      data: {
        email: tombstoneEmail,
        firstName: null,
        lastName: null,
        phone: null,
        // Credentials are destroyed, not merely disabled. A retained hash is
        // still personal data and still crackable.
        passwordHash: null,
        totpSecret: null,
        totpEnabledAt: null,
        emailVerifiedAt: null,
        marketingConsentAt: null,
        marketingConsentVersion: null,
        anonymisedAt,
      },
      select: CUSTOMER_SELECT,
    });
  }

  async revokeAllSessions(customerId: string, revokedAt: Date): Promise<number> {
    const result = await this.client.session.updateMany({
      where: { customerId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  async revokeAllRefreshTokens(customerId: string, revokedAt: Date): Promise<number> {
    const result = await this.client.refreshToken.updateMany({
      where: { customerId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  async deleteRecoveryCodes(customerId: string): Promise<number> {
    const result = await this.client.recoveryCode.deleteMany({ where: { customerId } });
    return result.count;
  }

  // --- admin ---------------------------------------------------------------

  async listCustomers(filter: CustomerListFilter): Promise<readonly CustomerRow[]> {
    const createdAt = {
      ...(filter.createdAfter !== undefined ? { gte: filter.createdAfter } : {}),
      ...(filter.createdBefore !== undefined ? { lte: filter.createdBefore } : {}),
    };

    const where: Prisma.CustomerWhereInput = {
      // `contains` on a citext column is already case-insensitive, so no `mode`
      // is needed — and adding one would make Postgres drop the index.
      ...(filter.emailContains !== undefined
        ? { email: { contains: filter.emailContains } }
        : {}),
      ...(filter.role !== undefined ? { role: filter.role } : {}),
      ...(filter.anonymised !== undefined
        ? { anonymisedAt: filter.anonymised ? { not: null } : null }
        : {}),
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    };

    return this.client.customer.findMany({
      where,
      // `id` is the tiebreaker. `createdAt` alone is not unique, and a
      // non-deterministic order makes cursor pagination skip or repeat rows at
      // every page boundary where two customers share a timestamp.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.take,
      ...(filter.cursorId !== undefined
        ? { cursor: { id: filter.cursorId }, skip: 1 }
        : {}),
      select: CUSTOMER_SELECT,
    });
  }

  /**
   * Per-customer order aggregates.
   *
   * Raw SQL rather than Prisma's `groupBy` for one specific reason (spec §4):
   * the money columns are 32-bit `Int`, and `_sum` over them is computed by
   * Postgres as `integer`, which OVERFLOWS. Casting to bigint before summing is
   * the fix, and Prisma's aggregate API gives no way to express the cast.
   *
   * The sum is NET of refunds — a customer who was fully refunded has a lifetime
   * value of zero, not of the amount they were briefly charged.
   */
  async aggregateOrderStats(
    customerIds: readonly string[],
  ): Promise<readonly CustomerOrderStats[]> {
    if (customerIds.length === 0) {
      return [];
    }

    const statuses = Prisma.join(REVENUE_STATUSES.map((status) => Prisma.sql`${status}`));

    /**
     * COLUMN NAMES ARE QUOTED because this schema is camelCase.
     *
     * Postgres folds an UNQUOTED identifier to lower case, so `customer_id`
     * asks for a column literally named `customer_id` and the whole query dies
     * with 42703 — which surfaces as a 500 on the admin customers page, not as
     * anything resembling a naming problem. The OUTPUT aliases stay snake_case
     * on purpose: `orderStatsRowSchema` is `.strict()` and parses those keys.
     */
    const rows = await this.client.$queryRaw<readonly unknown[]>`
      SELECT
        "customerId" AS customer_id,
        COUNT(*)::bigint AS order_count,
        SUM(("grandTotal" - "refundedTotal")::bigint)::bigint AS lifetime_value,
        MAX("placedAt") AS last_order_at
      FROM "order"
      WHERE "customerId" = ANY(${[...customerIds]}::uuid[])
        AND status::text IN (${statuses})
      GROUP BY "customerId"
    `;

    return rows.map((row) => {
      const parsed = orderStatsRowSchema.parse(row);
      return {
        customerId: parsed.customer_id,
        orderCount: Number(parsed.order_count),
        lifetimeValueMinor: parsed.lifetime_value ?? 0n,
        lastOrderAt: parsed.last_order_at,
      };
    });
  }
}

@Injectable()
export class PrismaUsersRepository
  extends PrismaUsersDataAccess
  implements UsersRepository
{
  constructor(private readonly prisma: PrismaService) {
    super(prisma);
  }

  async transaction<T>(work: (tx: UsersDataAccess) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) =>
      work(new PrismaUsersDataAccess(tx)),
    );
  }
}
