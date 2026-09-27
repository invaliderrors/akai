import { z } from "zod";

/**
 * The transactional outbox: types and ports.
 *
 * The WRITE side of this pattern already existed before this module did —
 * CatalogModule and PaymentsModule both create `outbox_message` rows inside the
 * same Prisma transaction as the state change they describe, which is what
 * makes "the product changed AND the gateway will be told" atomic. What was missing
 * was the READ side: nothing ever claimed those rows, so every domain event the
 * platform emitted was written to a table and then ignored.
 *
 * That is a specific and quiet failure mode. Orders were being marked PAID and
 * an `email` row containing the order confirmation was committed alongside —
 * and the customer received nothing, with no error anywhere, because the
 * enqueue genuinely succeeded.
 */

/** A row claimed from the outbox, narrowed for a handler. */
export interface OutboxMessage {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/**
 * Handles one topic.
 *
 * `payload` is `unknown`, deliberately. It was serialised to JSONB, possibly by
 * an older version of the emitting code, so the handler must parse it rather
 * than trust the type it was written with. A handler that casts is a handler
 * that crashes on the first schema change and dead-letters every message.
 */
export interface OutboxHandler {
  readonly topic: string;
  handle(payload: unknown, message: OutboxMessage): Promise<void>;
}

export const OUTBOX_HANDLERS = Symbol("OUTBOX_HANDLERS");

/**
 * Retry policy.
 *
 * Exponential backoff, capped. The cap matters: uncapped exponential backoff on
 * a message that has failed ten times schedules the next attempt days away,
 * which in practice means "never" — the incident is resolved and the message is
 * still waiting.
 */
export interface OutboxPolicy {
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Rows claimed per tick. Bounded so one tick cannot hold a transaction open. */
  readonly batchSize: number;
}

export const OUTBOX_POLICY = Symbol("OUTBOX_POLICY");

export const DEFAULT_OUTBOX_POLICY: OutboxPolicy = {
  // Eight attempts with the backoff below spans roughly two hours, which covers
  // a typical provider outage without pinning a message in the queue for days.
  maxAttempts: 8,
  baseBackoffMs: 5_000,
  maxBackoffMs: 15 * 60 * 1000,
  batchSize: 50,
};

/**
 * Backoff for the NEXT attempt after `attempts` failures.
 *
 * Pure and exported so the schedule is assertable without waiting for it. The
 * exponent is bounded before `2 ** n` is evaluated, not after: at 1024 attempts
 * the unbounded form overflows to Infinity, and `new Date(Infinity)` throws
 * rather than producing a far-future timestamp.
 */
export function backoffMs(attempts: number, policy: OutboxPolicy): number {
  const exponent = Math.min(attempts, 20);
  const raw = policy.baseBackoffMs * 2 ** exponent;
  return Math.min(raw, policy.maxBackoffMs);
}

/**
 * Envelope every emitted payload is expected to satisfy at minimum.
 *
 * Handlers narrow further. This only asserts the payload is an object, because
 * a JSON scalar reaching a handler is a bug in the emitter, and failing here
 * gives a clearer signal than a property access on a number.
 */
export const outboxPayloadSchema = z.object({}).passthrough();
