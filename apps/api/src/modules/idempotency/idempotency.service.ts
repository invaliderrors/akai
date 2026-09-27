import { ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@akai/db";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Idempotency for unsafe (state-changing), money- or catalogue-creating POSTs.
 *
 * The problem being solved is not theoretical: an admin fires a 900-product bulk
 * import, the proxy times out at 60s while the transaction is still running, the
 * dashboard retries, and the catalogue is imported twice. Retries are a normal
 * part of HTTP, so the endpoint has to be safe under them rather than hoping
 * they do not happen.
 *
 * MECHANISM — reserve-then-execute, not check-then-write:
 * the reservation row is INSERTed first, and the PRIMARY KEY (key, userId,
 * route) does the mutual exclusion. A check-then-write ("does this key exist?
 * no? then run") races two concurrent retries straight through the gap between
 * the read and the write, which is exactly the scenario it was meant to stop.
 *
 * The request body is HASHED into the row, so replaying a key with a DIFFERENT
 * body is a 409 rather than a silent replay of an unrelated response — that
 * distinction is what stops a key collision from returning one admin's result
 * to another's request.
 *
 * IT LIVED IN modules/admin UNTIL NOW, with a note saying it belonged here and
 * that the logic was not admin-specific. That was correct, and the cost of the
 * delay was concrete: `POST /v1/checkout` — the one money-creating POST in the
 * platform — read no `Idempotency-Key` at all, so a double-submitted checkout
 * created two orders and two payment sessions. Nothing about this class was ever
 * admin-shaped; only its address was.
 */

/** How long a completed result stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const PRISMA_UNIQUE_VIOLATION = "P2002";

export interface IdempotentExecution<T> {
  readonly key: string;
  readonly userId: string;
  readonly route: string;
  readonly request: unknown;
  readonly handler: () => Promise<T>;
  /** Validates a replayed snapshot back into `T`. Never trust stored JSON blindly. */
  readonly responseSchema: z.ZodType<T>;
}

export interface IdempotentResult<T> {
  readonly value: T;
  /** True when the response came from a stored snapshot rather than the handler. */
  readonly replayed: boolean;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Canonical request hash.
   *
   * Object keys are sorted recursively before hashing so that two semantically
   * identical bodies that serialise with different key ORDER (different client,
   * different JSON library) do not read as a conflicting retry.
   */
  hashRequest(request: unknown): string {
    return createHash("sha256").update(this.canonicalise(request)).digest("hex");
  }

  private canonicalise(value: unknown): string {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value ?? null) ?? "null";
    }
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.canonicalise(entry)).join(",")}]`;
    }
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${this.canonicalise(entryValue)}`);

    return `{${entries.join(",")}}`;
  }

  async execute<T>(execution: IdempotentExecution<T>): Promise<IdempotentResult<T>> {
    const requestHash = this.hashRequest(execution.request);
    const identity = {
      key: execution.key.slice(0, 128),
      userId: execution.userId.slice(0, 64),
      route: execution.route.slice(0, 128),
    };

    const reserved = await this.reserve(identity, requestHash);

    if (!reserved) {
      return {
        value: await this.replay(identity, requestHash, execution.responseSchema),
        replayed: true,
      };
    }

    let value: T;
    try {
      value = await execution.handler();
    } catch (error) {
      // Release the reservation so a genuine retry after a transient failure is
      // not permanently locked out by a key that never produced a result. Only
      // the FAILED attempt's row is removed; a stored success is never deleted.
      await this.release(identity);
      throw error;
    }

    await this.prisma.idempotencyRecord.updateMany({
      where: identity,
      data: { responseSnapshot: this.toJson(value), statusCode: 200 },
    });

    return { value, replayed: false };
  }

  /** True when this caller won the reservation and should run the handler. */
  private async reserve(
    identity: { key: string; userId: string; route: string },
    requestHash: string,
  ): Promise<boolean> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          ...identity,
          requestHash,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        return false;
      }
      throw error;
    }
  }

  private async replay<T>(
    identity: { key: string; userId: string; route: string },
    requestHash: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { key_userId_route: identity },
    });

    if (existing === null) {
      // The row vanished between the failed INSERT and this read — a concurrent
      // release or TTL sweep. Treated as a conflict rather than retried, because
      // silently re-running an unsafe handler is the one outcome this service
      // exists to prevent.
      throw new ConflictException("Idempotent request is still in progress");
    }

    if (existing.requestHash !== requestHash) {
      throw new ConflictException(
        "Idempotency-Key was already used with a different request body",
      );
    }

    if (existing.responseSnapshot === null) {
      // Reserved but not yet completed: the original request is still running.
      // 409 tells the client to wait rather than duplicating the work.
      throw new ConflictException("Idempotent request is still in progress");
    }

    // The stored snapshot is JSON from the database — external data by the time
    // it comes back, even though we wrote it. It is parsed, not trusted: a
    // schema change between write and replay must fail loudly, not deliver a
    // shape the caller cannot handle.
    return schema.parse(existing.responseSnapshot);
  }

  private async release(identity: {
    key: string;
    userId: string;
    route: string;
  }): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({
      where: { ...identity, responseSnapshot: { equals: Prisma.DbNull } },
    });
  }

  /**
   * Serialise a handler result for storage.
   *
   * Round-tripped through JSON so what is STORED is exactly what a replay will
   * return. Storing a richer in-memory object would let the first caller and the
   * replaying caller receive different shapes.
   */
  private toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    const serialised: unknown = JSON.parse(JSON.stringify(value ?? null));
    const parsed = jsonValueSchema.parse(serialised);
    // A JSON `null` and "no value stored" are different facts in a nullable Json
    // column; Prisma.JsonNull is the former, and conflating them would make a
    // handler that legitimately returned null look like an incomplete request.
    return parsed === null ? Prisma.JsonNull : parsed;
  }
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A JSON value, validated at the storage boundary.
 *
 * Exists so `toJson` never lets `JSON.parse`'s `any` return flow into a Prisma
 * `data:` field — that implicit-any hole is exactly what the engineering rules
 * ban, and a `data:` spread is the worst possible place for it to land.
 */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
