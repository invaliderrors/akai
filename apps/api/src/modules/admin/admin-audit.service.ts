import { Injectable } from "@nestjs/common";
import { Prisma } from "@akai/db";
import type { Paginated, Role } from "@akai/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { paginateCursor } from "./pagination";
import type { AuditLogQuery } from "./admin.dto";
import type { AdminActor } from "./admin.types";

/**
 * An audit row as listed. The `diff` is deliberately NOT included in the list
 * projection: it is the largest column and is only meaningful one row at a time.
 */
export interface AuditLogListItem {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorRole: Role | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly createdAt: string;
}

/**
 * Keys whose VALUES are redacted before an audit row is written.
 *
 * Redaction happens at WRITE time, deliberately. Redacting at read time leaves
 * the raw value sitting in an append-only table that the runtime role cannot
 * UPDATE or DELETE — a value written unredacted once is leaked permanently, with
 * no mechanism to take it back.
 *
 * Matching is case-insensitive and substring-based so `billFirstName`,
 * `shipPhone` and `customerEmail` are all caught without enumerating every
 * column in the schema.
 */
const REDACTED_KEY_FRAGMENTS: readonly string[] = [
  "password",
  "passwordhash",
  "token",
  "secret",
  "totp",
  "email",
  "phone",
  "firstname",
  "lastname",
  "line1",
  "line2",
  "postalcode",
  "vatnumber",
  "ipaddress",
  "recoverycode",
];

export const REDACTED = "[redacted]";

function isRedactedKey(key: string): boolean {
  const normalised = key.toLowerCase();
  return REDACTED_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * A JSON-safe value. Anything an audit diff may legally hold.
 *
 * Mutable array/object branches, deliberately: this type must be structurally
 * assignable to Prisma's `InputJsonValue` so the diff can be written without a
 * cast, and a `readonly` array branch is not.
 */
export type AuditValue =
  | string
  | number
  | boolean
  | null
  | AuditValue[]
  | { [key: string]: AuditValue };

export interface AuditSnapshot {
  readonly [key: string]: AuditValue;
}

/**
 * A `type` alias, NOT an interface — and that distinction is load-bearing.
 * TypeScript gives object-literal type aliases an implicit index signature but
 * gives interfaces none, so an interface here is not assignable to Prisma's
 * `InputJsonObject` and the diff could only be written through a cast.
 */
export type AuditDiffEntry = {
  readonly before: AuditValue;
  readonly after: AuditValue;
};

/** Changed keys only, each carrying its before/after pair. */
export type AuditDiff = Readonly<Record<string, AuditDiffEntry>>;

export interface RecordAuditInput {
  readonly actor: AdminActor;
  /** Verb, e.g. "product.bulk_import". Kept short — it is an index key. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  /** Null on create. */
  readonly before: AuditSnapshot | null;
  /** Null on delete. */
  readonly after: AuditSnapshot | null;
}

/** Prisma client or an interactive-transaction client. */
export type AuditWriter = PrismaService | Prisma.TransactionClient;

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write one audit entry.
   *
   * `writer` defaults to the base client but SHOULD be the transaction client of
   * the change being described (spec §13). Writing the audit row in the same
   * transaction is what guarantees a rolled-back change cannot leave a phantom
   * audit entry claiming it happened — and, conversely, that a successful change
   * can never be unaudited.
   */
  async record(input: RecordAuditInput, writer: AuditWriter = this.prisma): Promise<void> {
    const diff = this.buildDiff(input.before, input.after);

    await writer.auditLogEntry.create({
      data: {
        actorId: input.actor.customerId,
        actorRole: input.actor.role,
        action: input.action.slice(0, 80),
        entityType: input.entityType.slice(0, 64),
        entityId: input.entityId.slice(0, 64),
        diff,
        ipAddress: input.actor.ipAddress,
        userAgent: input.actor.userAgent,
        requestId: input.actor.requestId.slice(0, 64),
      },
    });
  }

  /**
   * List audit entries, newest first, cursor-paginated.
   *
   * Read-only by construction — there is no update or delete method on this
   * service, and the runtime DB role does not hold those grants on the table
   * anyway. An audit log the application can rewrite is not an audit log.
   */
  async list(query: AuditLogQuery): Promise<Paginated<AuditLogListItem>> {
    const where: Prisma.AuditLogEntryWhereInput = {
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
      ...(query.action === undefined ? {} : { action: query.action }),
    };

    return paginateCursor(
      { cursor: query.cursor ?? null, limit: query.limit },
      (entry) => entry.id,
      async ({ take, cursor }) => {
        const rows = await this.prisma.auditLogEntry.findMany({
          where,
          // Tie-broken by id: `createdAt` alone is not unique, and two rows
          // sharing a timestamp at a page boundary would otherwise be
          // duplicated or skipped depending on scan order.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
        });

        return rows.map((row) => ({
          id: row.id,
          actorId: row.actorId,
          actorRole: row.actorRole,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          requestId: row.requestId,
          createdAt: row.createdAt.toISOString(),
        }));
      },
    );
  }

  /**
   * Build a CHANGED-KEYS-ONLY, PII-redacted diff.
   *
   * Only changed keys are stored. A full before/after pair per row would turn
   * the audit log into a second copy of the products table — expensive, and it
   * buries the one field that actually moved under forty that did not.
   */
  buildDiff(before: AuditSnapshot | null, after: AuditSnapshot | null): AuditDiff {
    const keys = new Set<string>([
      ...Object.keys(before ?? {}),
      ...Object.keys(after ?? {}),
    ]);

    const diff: Record<string, AuditDiffEntry> = {};

    for (const key of keys) {
      const beforeValue = before?.[key] ?? null;
      const afterValue = after?.[key] ?? null;

      if (this.isEqual(beforeValue, afterValue)) {
        continue;
      }

      diff[key] = isRedactedKey(key)
        ? {
            // The FACT of the change is retained even when the values are not.
            // "someone changed the billing email" is the audit-relevant signal;
            // the address itself is not, and storing it would defeat GDPR
            // erasure, which cannot reach an append-only table.
            before: beforeValue === null ? null : REDACTED,
            after: afterValue === null ? null : REDACTED,
          }
        : { before: this.redactNested(beforeValue), after: this.redactNested(afterValue) };
    }

    return diff;
  }

  /**
   * Recurse into objects and arrays so a PII key nested inside a variant or an
   * address object is redacted too. A top-level-only sweep is the usual way
   * personal data escapes into an audit log.
   */
  private redactNested(value: AuditValue): AuditValue {
    if (Array.isArray(value)) {
      return value.map((entry) => this.redactNested(entry));
    }
    if (typeof value === "object" && value !== null) {
      const result: Record<string, AuditValue> = {};
      for (const [key, nested] of Object.entries(value)) {
        result[key] = isRedactedKey(key) ? REDACTED : this.redactNested(nested);
      }
      return result;
    }
    return value;
  }

  private isEqual(a: AuditValue, b: AuditValue): boolean {
    if (a === b) {
      return true;
    }
    // Structural comparison via canonical JSON. Adequate here because audit
    // snapshots are already JSON-shaped by construction (they came from, or are
    // going to, a Json column) — there are no Dates, Maps or cycles to mishandle.
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
