import { randomUUID } from "node:crypto";
import type { AddressType, Role } from "@akai/contracts";
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
} from "../users.repository";

/**
 * In-memory UsersRepository for unit tests.
 *
 * THE POINT OF THIS FILE: it enforces ownership scoping the same way the SQL
 * does. `findAddressOwned` matches on (id AND customerId AND not deleted) —
 * exactly the predicate in prisma-users.repository.ts. A fake that ignored
 * `customerId` would make every cross-tenant test pass while proving nothing,
 * which is the usual reason authorisation tests give false confidence.
 *
 * It is a fake, not a mock: real behaviour, no call assertions. Tests then say
 * "customer B cannot read A's address" rather than "the repository was called
 * with these arguments", and stay true through a refactor of how that is
 * achieved.
 *
 * LIMIT, stated so nobody reads more into a green suite than is there:
 * `transaction()` runs the callback but cannot roll back. Atomicity — that a
 * failed erasure leaves no half-tombstoned account — is only provable against
 * real Postgres in apps/api-e2e.
 */

export interface FakeOrder {
  readonly customerId: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly currency: string;
  readonly grandTotal: number;
  readonly refundedTotal: number;
  readonly placedAt: Date;
  readonly invoiceNumber: string | null;
}

export interface FakeConsent extends ConsentExportRow {
  readonly customerId: string;
}

export interface FakeEmail extends EmailExportRow {
  readonly recipient: string;
}

export interface FakeSession extends SessionExportRow {
  readonly customerId: string;
  readonly revokedAt: Date | null;
}

export interface FakeToken {
  readonly customerId: string;
  readonly revokedAt: Date | null;
}

export interface FakeRecoveryCode {
  readonly customerId: string;
}

const REVENUE_STATUSES: readonly string[] = [
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
];

const OPEN_ORDER_STATUSES: readonly string[] = [
  "PENDING",
  "AWAITING_PAYMENT",
  "PAID",
  "FULFILLING",
  "SHIPPED",
];

export class FakeUsersRepository implements UsersRepository {
  public customers: CustomerRow[] = [];
  public addresses: AddressRow[] = [];
  public orders: FakeOrder[] = [];
  public consents: FakeConsent[] = [];
  public emails: FakeEmail[] = [];
  public sessions: FakeSession[] = [];
  public refreshTokens: FakeToken[] = [];
  public recoveryCodes: FakeRecoveryCode[] = [];

  /** Set to make the next transaction throw, for failure-path tests. */
  public failNextTransaction: Error | null = null;

  async transaction<T>(work: (tx: UsersDataAccess) => Promise<T>): Promise<T> {
    if (this.failNextTransaction !== null) {
      const error = this.failNextTransaction;
      this.failNextTransaction = null;
      throw error;
    }
    return work(this);
  }

  // --- profile -------------------------------------------------------------

  async findCustomerById(id: string): Promise<CustomerRow | null> {
    return this.customers.find((customer) => customer.id === id) ?? null;
  }

  async updateCustomerProfile(id: string, patch: ProfilePatch): Promise<CustomerRow> {
    const index = this.customers.findIndex((customer) => customer.id === id);
    const existing = this.customers[index];
    if (existing === undefined) {
      throw new Error(`No customer ${id}`);
    }
    const updated: CustomerRow = {
      ...existing,
      ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
      ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      updatedAt: new Date(existing.updatedAt.getTime() + 1000),
    };
    this.customers[index] = updated;
    return updated;
  }

  // --- address book --------------------------------------------------------

  private live(customerId: string): AddressRow[] {
    return this.addresses.filter(
      (address) => address.customerId === customerId && address.deletedAt === null,
    );
  }

  async listAddresses(customerId: string): Promise<readonly AddressRow[]> {
    return [...this.live(customerId)].sort(byNewestFirst);
  }

  async listAddressesOfType(
    customerId: string,
    type: AddressType,
  ): Promise<readonly AddressRow[]> {
    return this.live(customerId)
      .filter((address) => address.type === type)
      .sort(byNewestFirst);
  }

  /** (id AND customerId AND live) — the ownership predicate, mirrored from SQL. */
  async findAddressOwned(id: string, customerId: string): Promise<AddressRow | null> {
    return (
      this.addresses.find(
        (address) =>
          address.id === id &&
          address.customerId === customerId &&
          address.deletedAt === null,
      ) ?? null
    );
  }

  async countAddressesOfType(customerId: string, type: AddressType): Promise<number> {
    return this.live(customerId).filter((address) => address.type === type).length;
  }

  async clearDefaultOfType(customerId: string, type: AddressType): Promise<void> {
    this.addresses = this.addresses.map((address) =>
      address.customerId === customerId &&
      address.type === type &&
      address.deletedAt === null
        ? { ...address, isDefault: false }
        : address,
    );
  }

  async setAddressDefault(
    id: string,
    customerId: string,
    isDefault: boolean,
  ): Promise<void> {
    this.addresses = this.addresses.map((address) =>
      address.id === id && address.customerId === customerId && address.deletedAt === null
        ? { ...address, isDefault }
        : address,
    );
  }

  async insertAddress(customerId: string, data: AddressInsert): Promise<AddressRow> {
    const now = new Date();
    const row: AddressRow = {
      id: randomUUID(),
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
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.addresses.push(row);
    return row;
  }

  async updateAddressOwned(
    id: string,
    customerId: string,
    patch: AddressPatch,
  ): Promise<AddressRow | null> {
    const index = this.addresses.findIndex(
      (address) =>
        address.id === id &&
        address.customerId === customerId &&
        address.deletedAt === null,
    );
    const existing = this.addresses[index];
    if (existing === undefined) {
      return null;
    }
    const updated: AddressRow = {
      ...existing,
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
      updatedAt: new Date(),
    };
    this.addresses[index] = updated;
    return updated;
  }

  async softDeleteAddressOwned(
    id: string,
    customerId: string,
  ): Promise<AddressRow | null> {
    const existing = await this.findAddressOwned(id, customerId);
    if (existing === null) {
      return null;
    }
    this.addresses = this.addresses.map((address) =>
      address.id === id
        ? { ...address, deletedAt: new Date(), isDefault: false }
        : address,
    );
    return existing;
  }

  async softDeleteAllAddresses(customerId: string): Promise<number> {
    const affected = this.live(customerId);
    const ids = new Set(affected.map((address) => address.id));
    this.addresses = this.addresses.map((address) =>
      ids.has(address.id)
        ? { ...address, deletedAt: new Date(), isDefault: false }
        : address,
    );
    return affected.length;
  }

  // --- GDPR export ---------------------------------------------------------

  async listOrdersForExport(customerId: string): Promise<readonly OrderExportRow[]> {
    return this.orders
      .filter((order) => order.customerId === customerId)
      .map((order) => ({
        orderNumber: order.orderNumber,
        status: order.status,
        currency: order.currency,
        grandTotal: order.grandTotal,
        placedAt: order.placedAt,
        invoiceNumber: order.invoiceNumber,
      }));
  }

  async listConsentRecords(customerId: string): Promise<readonly ConsentExportRow[]> {
    return this.consents.filter((consent) => consent.customerId === customerId);
  }

  async listEmailEvents(email: string): Promise<readonly EmailExportRow[]> {
    return this.emails.filter(
      (entry) => entry.recipient.toLowerCase() === email.toLowerCase(),
    );
  }

  async listSessions(customerId: string): Promise<readonly SessionExportRow[]> {
    return this.sessions.filter(
      (session) => session.customerId === customerId && session.revokedAt === null,
    );
  }

  // --- erasure -------------------------------------------------------------

  async countOpenOrders(customerId: string): Promise<number> {
    return this.orders.filter(
      (order) =>
        order.customerId === customerId && OPEN_ORDER_STATUSES.includes(order.status),
    ).length;
  }

  async countOrders(customerId: string): Promise<number> {
    return this.orders.filter((order) => order.customerId === customerId).length;
  }

  async anonymiseCustomer(
    id: string,
    tombstoneEmail: string,
    anonymisedAt: Date,
  ): Promise<CustomerRow> {
    const index = this.customers.findIndex((customer) => customer.id === id);
    const existing = this.customers[index];
    if (existing === undefined) {
      throw new Error(`No customer ${id}`);
    }
    const updated: CustomerRow = {
      ...existing,
      email: tombstoneEmail,
      firstName: null,
      lastName: null,
      phone: null,
      emailVerifiedAt: null,
      marketingConsentAt: null,
      totpEnabledAt: null,
      anonymisedAt,
    };
    this.customers[index] = updated;
    return updated;
  }

  async revokeAllSessions(customerId: string, revokedAt: Date): Promise<number> {
    const affected = this.sessions.filter(
      (session) => session.customerId === customerId && session.revokedAt === null,
    );
    this.sessions = this.sessions.map((session) =>
      session.customerId === customerId && session.revokedAt === null
        ? { ...session, revokedAt }
        : session,
    );
    return affected.length;
  }

  async revokeAllRefreshTokens(customerId: string, revokedAt: Date): Promise<number> {
    const affected = this.refreshTokens.filter(
      (token) => token.customerId === customerId && token.revokedAt === null,
    );
    this.refreshTokens = this.refreshTokens.map((token) =>
      token.customerId === customerId && token.revokedAt === null
        ? { ...token, revokedAt }
        : token,
    );
    return affected.length;
  }

  async deleteRecoveryCodes(customerId: string): Promise<number> {
    const affected = this.recoveryCodes.filter(
      (code) => code.customerId === customerId,
    );
    this.recoveryCodes = this.recoveryCodes.filter(
      (code) => code.customerId !== customerId,
    );
    return affected.length;
  }

  // --- admin ---------------------------------------------------------------

  async listCustomers(filter: CustomerListFilter): Promise<readonly CustomerRow[]> {
    let rows = [...this.customers];

    if (filter.emailContains !== undefined) {
      const needle = filter.emailContains.toLowerCase();
      rows = rows.filter((row) => row.email.toLowerCase().includes(needle));
    }
    if (filter.role !== undefined) {
      rows = rows.filter((row) => row.role === filter.role);
    }
    if (filter.anonymised !== undefined) {
      rows = rows.filter((row) =>
        filter.anonymised === true ? row.anonymisedAt !== null : row.anonymisedAt === null,
      );
    }
    if (filter.createdAfter !== undefined) {
      const after = filter.createdAfter;
      rows = rows.filter((row) => row.createdAt.getTime() >= after.getTime());
    }
    if (filter.createdBefore !== undefined) {
      const before = filter.createdBefore;
      rows = rows.filter((row) => row.createdAt.getTime() <= before.getTime());
    }

    rows.sort((left, right) => {
      const byDate = right.createdAt.getTime() - left.createdAt.getTime();
      return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
    });

    if (filter.cursorId !== undefined) {
      const cursorIndex = rows.findIndex((row) => row.id === filter.cursorId);
      rows = cursorIndex === -1 ? [] : rows.slice(cursorIndex + 1);
    }

    return rows.slice(0, filter.take);
  }

  async aggregateOrderStats(
    customerIds: readonly string[],
  ): Promise<readonly CustomerOrderStats[]> {
    const wanted = new Set(customerIds);
    const grouped = new Map<string, FakeOrder[]>();

    for (const order of this.orders) {
      if (!wanted.has(order.customerId) || !REVENUE_STATUSES.includes(order.status)) {
        continue;
      }
      const bucket = grouped.get(order.customerId) ?? [];
      bucket.push(order);
      grouped.set(order.customerId, bucket);
    }

    return [...grouped.entries()].map(([customerId, orders]) => ({
      customerId,
      orderCount: orders.length,
      // BigInt arithmetic, matching the ::bigint cast in the real query.
      lifetimeValueMinor: orders.reduce(
        (total, order) => total + BigInt(order.grandTotal - order.refundedTotal),
        0n,
      ),
      lastOrderAt: orders.reduce<Date | null>(
        (latest, order) =>
          latest === null || order.placedAt.getTime() > latest.getTime()
            ? order.placedAt
            : latest,
        null,
      ),
    }));
  }
}

function byNewestFirst(left: AddressRow, right: AddressRow): number {
  return right.createdAt.getTime() - left.createdAt.getTime();
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function makeCustomerRow(overrides: Partial<CustomerRow> = {}): CustomerRow {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const role: Role = "CUSTOMER";
  return {
    id: randomUUID(),
    email: `customer-${randomUUID().slice(0, 8)}@example.com`,
    emailVerifiedAt: now,
    firstName: "Ana",
    lastName: "García",
    phone: null,
    role,
    totpEnabledAt: null,
    marketingConsentAt: null,
    anonymisedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeAddressInsert(
  overrides: Partial<AddressInsert> = {},
): AddressInsert {
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
    isDefault: false,
    ...overrides,
  };
}
