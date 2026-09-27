import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import {
  adminCustomerSchema,
  type AdminCustomer,
  type Paginated,
} from "@akai/contracts";
import { assertFound } from "@akai/db";
import type { AdminUserListQuery } from "./dto/users.dto";
import {
  USERS_REPOSITORY,
  type CustomerListFilter,
  type CustomerOrderStats,
  type CustomerRow,
  type UsersRepository,
} from "./users.repository";

/**
 * Admin-side customer listing.
 *
 * This service reads across ALL customers by design — it is the one place in the
 * module without owner scoping. That is exactly why the authorisation boundary
 * is not in here: RolesGuard rejects a non-STAFF/ADMIN principal before any
 * method is reached, and admin-users.controller.ts carries `@Roles` at CLASS
 * level so a new method cannot be added without it.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(USERS_REPOSITORY) private readonly repository: UsersRepository,
  ) {}

  async list(query: AdminUserListQuery): Promise<Paginated<AdminCustomer>> {
    const filter: CustomerListFilter = {
      ...(query.email !== undefined ? { emailContains: query.email } : {}),
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.anonymised !== undefined ? { anonymised: query.anonymised } : {}),
      ...(query.createdAfter !== undefined
        ? { createdAfter: new Date(query.createdAfter) }
        : {}),
      ...(query.createdBefore !== undefined
        ? { createdBefore: new Date(query.createdBefore) }
        : {}),
      ...(query.cursor !== undefined ? { cursorId: query.cursor } : {}),
      // Over-fetch by exactly one. Asking for `limit` rows and then issuing a
      // COUNT to decide `hasMore` doubles the query load and can disagree with
      // itself under concurrent writes; the extra row cannot.
      take: query.limit + 1,
    };

    const rows = await this.repository.listCustomers(filter);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const stats = await this.repository.aggregateOrderStats(
      page.map((row) => row.id),
    );
    const statsById = new Map<string, CustomerOrderStats>(
      stats.map((entry) => [entry.customerId, entry]),
    );

    const last = page.at(-1);

    return {
      items: page.map((row) => this.toAdminCustomer(row, statsById.get(row.id))),
      // The cursor is the last row's id, not an offset, so an insert between
      // page fetches cannot shift rows across the boundary.
      nextCursor: hasMore && last !== undefined ? last.id : null,
      hasMore,
    };
  }

  async get(customerId: string): Promise<AdminCustomer> {
    const row = assertFound(
      await this.repository.findCustomerById(customerId),
      "Customer",
    );
    const [stats] = await this.repository.aggregateOrderStats([customerId]);
    return this.toAdminCustomer(row, stats);
  }

  private toAdminCustomer(
    row: CustomerRow,
    stats: CustomerOrderStats | undefined,
  ): AdminCustomer {
    return adminCustomerSchema.parse({
      id: row.id,
      email: row.email,
      emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      role: row.role,
      preferredLocale: row.preferredLocale,
      twoFactorEnabled: row.totpEnabledAt !== null,
      anonymisedAt: row.anonymisedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      // A customer with no orders has no stats row at all (GROUP BY returns
      // nothing), which is a zero, not a missing value.
      orderCount: stats?.orderCount ?? 0,
      lifetimeValueMinor: toSafeMinorUnits(stats?.lifetimeValueMinor ?? 0n),
      lastOrderAt: stats?.lastOrderAt?.toISOString() ?? null,
      marketingConsentAt: row.marketingConsentAt?.toISOString() ?? null,
    });
  }
}

/**
 * Narrow a bigint aggregate to a safe JS integer.
 *
 * Spec §4 requires money aggregates to be summed as `::bigint` because the
 * columns are 32-bit `Int` and a SUM over them overflows in Postgres. That gets
 * the total out of the database intact — but `Number(bigint)` past 2^53 starts
 * losing precision silently, which would turn a correct sum into a plausible
 * wrong one at the last step.
 *
 * So the conversion is explicit and it THROWS rather than rounding. A lifetime
 * value above 90 trillion minor units is a data-integrity incident, and a
 * 500 that says so is a far better outcome than an admin screen quietly
 * displaying a number that is almost right.
 *
 * A negative total is likewise rejected: refunds are netted off in the SQL, and
 * refunding more than was charged is an invariant violation the database's own
 * CHECK constraints are supposed to prevent.
 */
export function toSafeMinorUnits(value: bigint): number {
  if (value < 0n) {
    throw new InternalServerErrorException(
      "Aggregated lifetime value is negative — refund total exceeds charges",
    );
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InternalServerErrorException(
      "Aggregated lifetime value exceeds the safe integer range",
    );
  }
  return Number(value);
}
