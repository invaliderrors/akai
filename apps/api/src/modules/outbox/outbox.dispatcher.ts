import { Inject, Injectable } from "@nestjs/common";

import type { Logger } from "@akai/observability";
import { LOGGER } from "../observability/logger.module";
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from "./outbox.repository";
import {
  OUTBOX_POLICY,
  backoffMs,
  type OutboxHandler,
  type OutboxMessage,
  type OutboxPolicy,
} from "./outbox.types";

/** Per-pass tally. Logged by the runner so DLQ growth and throughput are observable. */
export interface OutboxDispatchSummary {
  readonly claimed: number;
  readonly processed: number;
  readonly retried: number;
  readonly dead: number;
}

/** Stringify an unknown thrown value without ever assuming it is an Error. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown handler error";
}

/**
 * THE READ SIDE OF THE OUTBOX.
 *
 * Producers commit `outbox_message` rows inside the transaction that justifies
 * them; before this class existed, nothing ever read them back, so every
 * enqueued side effect — order confirmations, provider catalog sync, invoice
 * allocation, fulfilment prep — was written to a table and silently abandoned.
 *
 * The dispatcher claims a batch through the repository (which increments
 * `attempts` and takes a `FOR UPDATE SKIP LOCKED` lock so replicas take
 * disjoint work), routes each row to the handler registered for its topic, and
 * records the result:
 *
 *  - handler resolves  → `markProcessed`
 *  - handler throws     → back off and reschedule, or dead-letter once
 *                         `attempts` reaches the policy ceiling
 *  - no handler         → treated as a failure, so an unrouted topic surfaces at
 *                         /admin/jobs rather than being marked done and lost
 *
 * It is deliberately NOT started here. The API imports OutboxModule so the
 * concern is composed and reviewable, but only the worker registers handlers
 * and ticks `dispatchDue` — the API must stay free to ACK a Wompi event in
 * under a second (spec §3/§9) instead of doing the heavy work inline.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly handlers = new Map<string, OutboxHandler>();

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly repository: OutboxRepository,
    @Inject(OUTBOX_POLICY) private readonly policy: OutboxPolicy,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Bind a handler to its topic. Rejects a second, different handler for the
   * same topic: a silent double-binding would split delivery for that topic
   * between two implementations depending on registration order, which is the
   * kind of bug that only shows up in production under load.
   */
  register(handler: OutboxHandler): void {
    const existing = this.handlers.get(handler.topic);
    if (existing !== undefined && existing !== handler) {
      throw new Error(
        `Two different handlers registered for outbox topic "${handler.topic}"`,
      );
    }
    this.handlers.set(handler.topic, handler);
  }

  registerAll(handlers: Iterable<OutboxHandler>): void {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  hasHandler(topic: string): boolean {
    return this.handlers.has(topic);
  }

  registeredTopics(): readonly string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Claim and dispatch one batch of due messages. Returns a tally rather than
   * void so the runner can log throughput and alert on a growing dead-letter
   * count. Never throws for a handler failure — a poison message must not stop
   * the pass that would otherwise drain the rest of the queue.
   */
  async dispatchDue(now: Date = new Date()): Promise<OutboxDispatchSummary> {
    const claimed = await this.repository.claimDue(this.policy.batchSize, now);

    let processed = 0;
    let retried = 0;
    let dead = 0;

    for (const message of claimed) {
      const outcome = await this.dispatchOne(message, now);
      if (outcome === "processed") {
        processed += 1;
      } else if (outcome === "dead") {
        dead += 1;
      } else {
        retried += 1;
      }
    }

    return { claimed: claimed.length, processed, retried, dead };
  }

  private async dispatchOne(
    message: OutboxMessage,
    now: Date,
  ): Promise<"processed" | "retried" | "dead"> {
    const handler = this.handlers.get(message.topic);

    if (handler === undefined) {
      return this.recordFailure(
        message,
        `No handler registered for outbox topic "${message.topic}"`,
        now,
      );
    }

    try {
      await handler.handle(message.payload, message);
      await this.repository.markProcessed(message.id, now);
      return "processed";
    } catch (error: unknown) {
      return this.recordFailure(message, describeError(error), now);
    }
  }

  private async recordFailure(
    message: OutboxMessage,
    error: string,
    now: Date,
  ): Promise<"retried" | "dead"> {
    // `attempts` was incremented at CLAIM time (see the repository), so it
    // already counts the attempt that just failed. Comparing against the
    // ceiling here means a message that has used up its budget dead-letters
    // instead of being rescheduled one more time.
    if (message.attempts >= this.policy.maxAttempts) {
      await this.repository.markFailed(message.id, error, null, true, now);
      this.logger.error(
        {
          outboxId: message.id,
          topic: message.topic,
          attempts: message.attempts,
          err: error,
        },
        "Outbox message dead-lettered after exhausting retries",
      );
      return "dead";
    }

    const availableAt = new Date(now.getTime() + backoffMs(message.attempts, this.policy));
    await this.repository.markFailed(message.id, error, availableAt, false, now);
    this.logger.warn(
      {
        outboxId: message.id,
        topic: message.topic,
        attempts: message.attempts,
        availableAt: availableAt.toISOString(),
        err: error,
      },
      "Outbox message failed; scheduled for retry",
    );
    return "retried";
  }
}
