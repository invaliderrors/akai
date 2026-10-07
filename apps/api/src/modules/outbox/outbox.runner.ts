import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";

import type { Logger } from "@akai/observability";
import { LOGGER } from "../observability/logger.module";
import { OutboxDispatcher } from "./outbox.dispatcher";
import { OUTBOX_HANDLERS, type OutboxHandler } from "./outbox.types";

/** Injection token + default for the poll cadence. */
export const OUTBOX_POLL_INTERVAL_MS = Symbol("OUTBOX_POLL_INTERVAL_MS");
export const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 1_000;

/**
 * The poll loop that DRIVES the outbox.
 *
 * A separate object from the dispatcher so the dispatch/retry/dead-letter logic
 * stays pure and synchronous to test, while the timing, the in-flight guard and
 * the graceful-drain live here.
 *
 * WHY IT DOES NOT AUTO-START. It is NOT an `OnApplicationBootstrap` hook. Nest
 * runs bootstrap hooks whenever the module is instantiated — including under
 * `Test.createTestingModule` and the api-e2e context — so an auto-starting
 * poller would open a timer and hit the database inside every integration test.
 * Instead `start()` is called explicitly from the process entrypoint
 * (`apps/api/src/main.ts`) AFTER `listen()`, which unit and integration tests
 * never execute. Shutdown is automatic via `OnApplicationShutdown`.
 *
 * WHERE IT RUNS. In the API process. The architecture's dedicated worker
 * (spec §3) cannot yet host the consumers: `@nx/enforce-module-boundaries`
 * forbids apps/worker importing apps/api by a relative path, and the consumers
 * (EmailOutboxHandler and friends) live in apps/api. Extracting them into a
 * server lib is the clean path to a separate process and is left as a followUp.
 * Crucially, running here does NOT slow the Wompi webhook: the webhook still
 * only writes an outbox row and ACKs; this loop drains it out of band on its own
 * schedule (spec §9's <1s ACK is preserved).
 */
@Injectable()
export class OutboxRunner implements OnApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private ticking = false;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject(OUTBOX_HANDLERS) private readonly handlers: readonly OutboxHandler[],
    @Inject(OUTBOX_POLL_INTERVAL_MS) private readonly intervalMs: number,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Register handlers and begin polling. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.dispatcher.registerAll(this.handlers);
    this.logger.info(
      { topics: this.dispatcher.registeredTopics(), intervalMs: this.intervalMs },
      "Outbox dispatcher started",
    );
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
    // Never hold the process open solely to poll; the HTTP server owns liveness.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    // Skip if a previous pass is still running: a single worker must not claim a
    // second overlapping batch, and a slow provider must not stack ticks.
    if (this.stopped || this.ticking) {
      this.scheduleNext();
      return;
    }
    this.ticking = true;
    try {
      const summary = await this.dispatcher.dispatchDue();
      if (summary.claimed > 0) {
        this.logger.info(
          {
            claimed: summary.claimed,
            processed: summary.processed,
            retried: summary.retried,
            dead: summary.dead,
          },
          "Outbox batch dispatched",
        );
      }
    } catch (error: unknown) {
      // A tick failure (e.g. the DB is briefly unreachable) must not kill the
      // loop; the next tick retries. Claimed rows keep their due time and are
      // re-claimed, so nothing is lost.
      this.logger.error({ err: error }, "Outbox dispatch tick failed");
    } finally {
      this.ticking = false;
      this.scheduleNext();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Let an in-flight batch finish rather than truncating a payment email mid-send.
    const deadline = Date.now() + 5_000;
    while (this.ticking && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
}
