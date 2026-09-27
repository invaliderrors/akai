import { Inject, Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import { OUTBOX_POLICY, type OutboxMessage, type OutboxPolicy } from "./outbox.types";

export const OUTBOX_REPOSITORY = Symbol("OUTBOX_REPOSITORY");

/**
 * Storage port for the outbox.
 *
 * Exists so the dispatcher's retry, backoff and dead-lettering logic can be
 * tested against an in-memory double without a database, while the SQL that
 * makes claiming safe under concurrency is isolated in one place.
 */
export interface OutboxRepository {
  /** Atomically claim up to `limit` due messages for this worker. */
  claimDue(limit: number, now: Date): Promise<readonly OutboxMessage[]>;
  markProcessed(id: string, now: Date): Promise<void>;
  /** Record a failure and schedule the retry, or dead-letter if exhausted. */
  markFailed(
    id: string,
    error: string,
    availableAt: Date | null,
    dead: boolean,
    now: Date,
  ): Promise<void>;
}

@Injectable()
export class PrismaOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: PrismaService,
    @Inject(OUTBOX_POLICY) private readonly policy: OutboxPolicy,
  ) {}

  /**
   * Claim due messages with `FOR UPDATE SKIP LOCKED`.
   *
   * THIS IS THE LOAD-BEARING QUERY. The obvious implementation — SELECT the due
   * rows, then UPDATE them — hands the same message to every worker that runs
   * the SELECT before any of them commits. For an `email` topic that means the
   * customer receives one order confirmation per replica, which is precisely
   * the outcome the idempotency work elsewhere exists to prevent.
   *
   * `SKIP LOCKED` makes concurrent workers take DISJOINT batches rather than
   * queueing behind each other, so throughput scales with replica count instead
   * of serialising.
   *
   * `attempts` is incremented at CLAIM time, not on failure. A handler that
   * crashes the process hard — OOM, SIGKILL — never reaches the failure path,
   * and a counter incremented only there would let that message be retried
   * forever. Incrementing on claim means a poison message that kills workers
   * still dead-letters.
   */
  async claimDue(limit: number, now: Date): Promise<readonly OutboxMessage[]> {
    const rows = await this.db.$queryRaw<
      readonly {
        id: string;
        topic: string;
        payload: unknown;
        attempts: number;
        availableAt: Date;
        createdAt: Date;
      }[]
    >`
      UPDATE "outbox_message"
      SET "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "outbox_message"
        WHERE "processedAt" IS NULL
          AND "deadAt" IS NULL
          AND "availableAt" <= ${now}
        ORDER BY "availableAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "topic", "payload", "attempts", "availableAt", "createdAt"
    `;

    // `UPDATE … RETURNING` does NOT return rows in the subquery's ORDER BY, and
    // the dispatcher handles a batch sequentially — so without this sort two
    // messages meant to go out in order (a shipment's "shipped" mail, then its
    // "delivered" mail, enqueued by consecutive transactions) could be sent the
    // wrong way round whenever they landed in the same batch.
    return [...rows].sort(compareDueOrder).map((row) => ({
      id: row.id,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  async markProcessed(id: string, now: Date): Promise<void> {
    await this.db.outboxMessage.update({
      where: { id },
      data: { processedAt: now, lastError: null },
    });
  }

  async markFailed(
    id: string,
    error: string,
    availableAt: Date | null,
    dead: boolean,
    now: Date,
  ): Promise<void> {
    await this.db.outboxMessage.update({
      where: { id },
      data: {
        // Truncated to the column width. An unbounded provider error message
        // (a stack trace, an HTML error page) would otherwise fail the UPDATE
        // that is trying to RECORD a failure, losing the diagnostic entirely.
        lastError: error.slice(0, 1000),
        ...(dead ? { deadAt: now } : {}),
        ...(availableAt === null ? {} : { availableAt }),
      },
    });
  }

  /** The configured batch size, so callers do not re-read the policy. */
  get batchSize(): number {
    return this.policy.batchSize;
  }
}

/** Oldest-due first; creation order breaks a tie in `availableAt`. */
export function compareDueOrder(
  a: { readonly availableAt: Date; readonly createdAt: Date; readonly id: string },
  b: { readonly availableAt: Date; readonly createdAt: Date; readonly id: string },
): number {
  return (
    a.availableAt.getTime() - b.availableAt.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
