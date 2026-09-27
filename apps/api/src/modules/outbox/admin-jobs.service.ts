import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type {
  Job,
  JobState,
  JobTopicSummary,
  JobsSummary,
  ListJobsQuery,
  Paginated,
} from "@akai/contracts";

import { PrismaService } from "../prisma/prisma.service";
import { OUTBOX_HANDLERS, type OutboxHandler } from "./outbox.types";

/**
 * Read-and-retry surface over the transactional outbox.
 *
 * ROUTED TOPICS COME FROM `OUTBOX_HANDLERS`, NOT FROM THE DISPATCHER. The
 * dispatcher's registry is populated by `OutboxRunner.start()`, which runs only
 * from the API entrypoint after `listen()` — so asking it during a request in a
 * process that has not started the runner (a test, a future worker-only split)
 * reports every topic as unrouted. The provider list is the same data, available
 * at construction, and independent of who started what.
 */

/** Mirrors the row's own state machine; nothing here is stored. */
function resolveState(row: {
  processedAt: Date | null;
  deadAt: Date | null;
  attempts: number;
}): JobState {
  if (row.processedAt !== null) return "PROCESSED";
  if (row.deadAt !== null) return "DEAD";
  // A row that has failed at least once is materially different from one that
  // has never been tried: the first is a problem, the second is just young.
  return row.attempts > 0 ? "RETRYING" : "PENDING";
}

const summaryRowSchema = z.object({
  topic: z.string(),
  pending: z.bigint(),
  retrying: z.bigint(),
  dead: z.bigint(),
  processed: z.bigint(),
  oldest_pending_at: z.date().nullable(),
});

@Injectable()
export class AdminJobsService {
  private readonly routedTopics: ReadonlySet<string>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_HANDLERS) handlers: readonly OutboxHandler[],
  ) {
    this.routedTopics = new Set(handlers.map((handler) => handler.topic));
  }

  async list(query: ListJobsQuery): Promise<Paginated<Job>> {
    const where: Prisma.OutboxMessageWhereInput = {
      ...(query.topic === undefined ? {} : { topic: query.topic }),
      ...stateFilter(query.state),
    };

    // Over-fetch by one to learn whether another page exists without a COUNT.
    const rows = await this.prisma.outboxMessage.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      // `payload` is DELIBERATELY not selected. It carries reset tokens and raw
      // recipient addresses, and no redactor here is trustworthy enough to make
      // serving it to every STAFF user safe.
      select: {
        id: true,
        topic: true,
        attempts: true,
        lastError: true,
        availableAt: true,
        processedAt: true,
        deadAt: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => this.toJob(row)),
      hasMore,
      nextCursor: hasMore && last !== undefined ? last.id : null,
    };
  }

  /**
   * Per-topic counts in ONE query.
   *
   * Raw SQL because it is four conditional aggregates over one grouped scan;
   * Prisma's groupBy cannot express `count(*) FILTER (WHERE …)` and would need a
   * round trip per state. Identifiers are QUOTED — this schema is camelCase and
   * Postgres folds unquoted names to lower case.
   */
  async summary(): Promise<JobsSummary> {
    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT
        topic,
        count(*) FILTER (WHERE "processedAt" IS NULL AND "deadAt" IS NULL AND attempts = 0)::bigint AS pending,
        count(*) FILTER (WHERE "processedAt" IS NULL AND "deadAt" IS NULL AND attempts > 0)::bigint AS retrying,
        count(*) FILTER (WHERE "deadAt" IS NOT NULL)::bigint AS dead,
        count(*) FILTER (WHERE "processedAt" IS NOT NULL)::bigint AS processed,
        min("createdAt") FILTER (WHERE "processedAt" IS NULL AND "deadAt" IS NULL) AS oldest_pending_at
      FROM "outbox_message"
      GROUP BY topic
      ORDER BY topic ASC
    `);

    const parsed = z.array(summaryRowSchema).parse(rows);

    const topics: JobTopicSummary[] = parsed.map((row) => ({
      topic: row.topic,
      pending: Number(row.pending),
      retrying: Number(row.retrying),
      dead: Number(row.dead),
      processed: Number(row.processed),
      unrouted: !this.routedTopics.has(row.topic),
      oldestPendingAt: row.oldest_pending_at?.toISOString() ?? null,
    }));

    return { topics, routedTopics: [...this.routedTopics].sort() };
  }

  /**
   * Hands a row back to the dispatcher.
   *
   * Clears `deadAt` and makes it due NOW. `attempts` is deliberately NOT reset:
   * it is the record of how much trouble this message has been, and zeroing it
   * would hide a message that has failed twenty times behind a fresh-looking
   * row. The dispatcher's own cap applies to the retried attempt, so a genuinely
   * broken message dead-letters again rather than looping forever.
   *
   * A PROCESSED row is refused: re-running a handled message re-sends an email
   * or re-mirrors a product, and "retry" must never mean "do it twice".
   */
  async retry(id: string): Promise<Job> {
    const existing = await this.prisma.outboxMessage.findUnique({
      where: { id },
      select: { id: true, processedAt: true },
    });

    if (existing === null) {
      throw new NotFoundException("Job not found");
    }
    if (existing.processedAt !== null) {
      throw new NotFoundException("This job already succeeded and cannot be retried");
    }

    const row = await this.prisma.outboxMessage.update({
      where: { id },
      data: { deadAt: null, availableAt: new Date(), lastError: null },
      select: {
        id: true,
        topic: true,
        attempts: true,
        lastError: true,
        availableAt: true,
        processedAt: true,
        deadAt: true,
        createdAt: true,
      },
    });

    return this.toJob(row);
  }

  private toJob(row: {
    id: string;
    topic: string;
    attempts: number;
    lastError: string | null;
    availableAt: Date;
    processedAt: Date | null;
    deadAt: Date | null;
    createdAt: Date;
  }): Job {
    return {
      id: row.id,
      topic: row.topic,
      state: resolveState(row),
      attempts: row.attempts,
      lastError: row.lastError,
      availableAt: row.availableAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
      deadAt: row.deadAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      unrouted: !this.routedTopics.has(row.topic),
    };
  }
}

/** Translates the derived state back into a row predicate. */
function stateFilter(state: JobState | undefined): Prisma.OutboxMessageWhereInput {
  switch (state) {
    case "PROCESSED":
      return { processedAt: { not: null } };
    case "DEAD":
      return { processedAt: null, deadAt: { not: null } };
    case "RETRYING":
      return { processedAt: null, deadAt: null, attempts: { gt: 0 } };
    case "PENDING":
      return { processedAt: null, deadAt: null, attempts: 0 };
    case undefined:
      return {};
  }
}
