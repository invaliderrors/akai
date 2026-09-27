import { Injectable } from "@nestjs/common";
import { Prisma } from "@akai/db";
import { z } from "zod";

import { PrismaService } from "../../prisma/prisma.service";

/**
 * The durable, cross-instance backing store for the rate limiter.
 *
 * WHY A STORE PORT SEPARATE FROM THE LIMITER: the ATOMIC part — "increment this
 * key's counter, resetting the window if it has lapsed, in one indivisible step"
 * — must run in the database, because a read-modify-write in application code
 * races across instances and is exactly the bypass SEV3 describes. Everything
 * else (turning a count into an allow/deny decision, computing Retry-After) is
 * pure and belongs in the limiter, where it is testable without a database.
 *
 * So the store's ONLY job is the atomic increment and a clear. The limiter reads
 * its result and decides. This split is what lets the decision logic be unit
 * tested against an in-memory fake while the real SQL is exercised by the
 * integration suite against a real Postgres.
 */
export interface RateLimitWindow {
  /** Hits recorded in the current window, INCLUDING the one just recorded. */
  readonly count: number;
  /** Epoch milliseconds when the current window ends. */
  readonly resetAt: number;
}

export interface RateLimitStore {
  /**
   * Atomically record one hit against `key` and return the resulting window.
   *
   * Semantics (implemented in ONE SQL statement so they hold under concurrency):
   *  - no row, or the stored window has lapsed at `now` → start a fresh window
   *    with count 1 and resetAt = now + windowMs;
   *  - otherwise → increment the existing count, leaving resetAt untouched.
   */
  increment(key: string, windowMs: number, now: Date): Promise<RateLimitWindow>;
  /** Forget a key entirely (a successful login forgives its failed burst). */
  clear(key: string): Promise<void>;
}

export const RATE_LIMIT_STORE = Symbol("RATE_LIMIT_STORE");

/**
 * `$queryRaw` returns `unknown` rows. Parse rather than cast (project rule): a
 * renamed column would otherwise surface as `undefined` with a `number` static
 * type. `coerce` absorbs the driver returning the timestamp as a Date or a
 * string and the integer as a number or bigint.
 */
const windowRowSchema = z
  .array(
    z.object({
      count: z.coerce.number().int(),
      resetAt: z.coerce.date(),
    }),
  )
  .length(1);

@Injectable()
export class PrismaRateLimitStore implements RateLimitStore {
  constructor(private readonly prisma: PrismaService) {}

  async increment(key: string, windowMs: number, now: Date): Promise<RateLimitWindow> {
    const resetAt = new Date(now.getTime() + windowMs);

    // The whole mechanism, in one statement. ON CONFLICT makes the insert and
    // the conditional increment a single atomic upsert; the CASE resets the
    // window when it has lapsed. RETURNING hands back the post-write state so no
    // second read (which would race) is needed.
    const rows: unknown = await this.prisma.$queryRaw(Prisma.sql`
      INSERT INTO "rate_limit_counter" ("key", "count", "resetAt", "updatedAt")
      VALUES (${key}, 1, ${resetAt}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "rate_limit_counter"."resetAt" <= ${now} THEN 1
          ELSE "rate_limit_counter"."count" + 1
        END,
        "resetAt" = CASE
          WHEN "rate_limit_counter"."resetAt" <= ${now} THEN ${resetAt}
          ELSE "rate_limit_counter"."resetAt"
        END,
        "updatedAt" = ${now}
      RETURNING "count", "resetAt"
    `);

    const parsed = windowRowSchema.safeParse(rows);
    if (!parsed.success) {
      throw new Error("rate_limit_counter upsert returned an unexpected row shape.");
    }
    const [row] = parsed.data;
    if (row === undefined) {
      throw new Error("rate_limit_counter upsert returned no row.");
    }

    return { count: row.count, resetAt: row.resetAt.getTime() };
  }

  async clear(key: string): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM "rate_limit_counter" WHERE "key" = ${key}`,
    );
  }
}
