import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";

import type { Logger } from "@akai/observability";
import { LOGGER } from "../observability/logger.module";

/**
 * The recurring background sweeps (spec §5 cron jobs), driven by a plain timer
 * loop.
 *
 * WHY THIS EXISTS. The domain already had the sweep methods —
 * `ProductInventoryService.releaseExpired` and `CartService.expireStaleCarts` —
 * written, tested and correct. Nothing ever CALLED them. An abandoned checkout
 * therefore held its stock reservation forever (the store gradually sells out of
 * items it physically has), and expired carts accumulated without bound. The
 * missing piece was not the logic, it was a scheduler to invoke it.
 *
 * WHY A TIMER LOOP AND NOT `@nestjs/schedule`. The transactional outbox in this
 * same codebase (`OutboxRunner`) already establishes the pattern: a hand-rolled,
 * unref'd `setTimeout` loop that does NOT auto-start on module init and is kicked
 * off explicitly from the process entrypoint after `listen()`. Reusing it keeps
 * one scheduling mechanism instead of two, adds no dependency, and — crucially —
 * keeps every integration test side-effect-free, because a `@Cron`-decorated
 * provider fires the moment the module is instantiated under
 * `Test.createTestingModule`.
 *
 * WHERE IT RUNS. In the API process today, for the same reason the outbox runner
 * does: the spec's dedicated worker (spec §3) cannot yet host these jobs because
 * `@nx/enforce-module-boundaries` forbids `apps/worker` importing the services
 * from `apps/api` by a relative path. Extracting the sweep services into a
 * server lib is the clean path to a separate process and is left as a followUp.
 * Running here costs nothing at request time — the loop is unref'd and drains
 * out of band.
 */

/** The narrow slice of the inventory service this runner drives. */
export interface ReservationSweeper {
  /** Release every stock reservation whose TTL has passed. Returns the count. */
  releaseExpired(now?: Date): Promise<number>;
}

/** The narrow slice of the cart service this runner drives. */
export interface CartSweeper {
  /** Reap carts past their TTL. Returns how many were removed. */
  expireStaleCarts(): Promise<number>;
}

export const RESERVATION_SWEEPER = Symbol("RESERVATION_SWEEPER");
export const CART_SWEEPER = Symbol("CART_SWEEPER");

/** Injection token + default for the sweep cadences. */
export const SCHEDULED_JOBS_INTERVALS = Symbol("SCHEDULED_JOBS_INTERVALS");

export interface ScheduledJobsIntervals {
  /** Stock is scarce; a reservation held past its TTL blocks a real sale. */
  readonly reservationExpiryMs: number;
  /** Cart reaping is housekeeping, not time-critical (expiry is enforced on read too). */
  readonly cartExpiryMs: number;
}

export const DEFAULT_SCHEDULED_JOBS_INTERVALS: ScheduledJobsIntervals = {
  reservationExpiryMs: 60_000,
  cartExpiryMs: 6 * 60 * 60 * 1000,
};

/** One recurring job: its cadence and the unit of work it runs. */
interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<number>;
}

/** Mutable per-job scheduling state, kept off the immutable definition above. */
interface JobState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

@Injectable()
export class ScheduledJobsRunner implements OnApplicationShutdown {
  private readonly jobs: readonly ScheduledJob[];
  private readonly state = new Map<string, JobState>();
  private started = false;
  private stopped = false;

  constructor(
    @Inject(RESERVATION_SWEEPER) reservations: ReservationSweeper,
    @Inject(CART_SWEEPER) carts: CartSweeper,
    @Inject(SCHEDULED_JOBS_INTERVALS) intervals: ScheduledJobsIntervals,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.jobs = [
      {
        name: "reservation-expiry",
        intervalMs: intervals.reservationExpiryMs,
        run: () => reservations.releaseExpired(),
      },
      {
        name: "cart-expiry",
        intervalMs: intervals.cartExpiryMs,
        run: () => carts.expireStaleCarts(),
      },
    ];

    for (const job of this.jobs) {
      this.state.set(job.name, { timer: null, running: false });
    }
  }

  /**
   * Begin scheduling every job. Idempotent — a second call is a no-op, so wiring
   * it in more than one composition root cannot double the cadence.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.logger.info(
      { jobs: this.jobs.map((job) => ({ name: job.name, intervalMs: job.intervalMs })) },
      "Scheduled jobs runner started",
    );
    for (const job of this.jobs) {
      this.scheduleNext(job);
    }
  }

  private scheduleNext(job: ScheduledJob): void {
    if (this.stopped) {
      return;
    }
    const state = this.state.get(job.name);
    if (state === undefined) {
      return;
    }
    state.timer = setTimeout(() => {
      void this.tick(job);
    }, job.intervalMs);
    // Never hold the process open solely to sweep; the HTTP server owns liveness.
    state.timer.unref();
  }

  private async tick(job: ScheduledJob): Promise<void> {
    const state = this.state.get(job.name);
    if (state === undefined) {
      return;
    }

    // Skip if the previous run of THIS job is still going: a slow sweep must not
    // stack overlapping passes that fight over the same rows.
    if (this.stopped || state.running) {
      this.scheduleNext(job);
      return;
    }

    state.running = true;
    try {
      const affected = await job.run();
      if (affected > 0) {
        this.logger.info({ job: job.name, affected }, "Scheduled job swept rows");
      }
    } catch (error: unknown) {
      // One failed sweep (e.g. the DB is briefly unreachable) must not kill the
      // loop; the next tick retries on the normal cadence.
      this.logger.error({ err: error, job: job.name }, "Scheduled job failed");
    } finally {
      state.running = false;
      this.scheduleNext(job);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    for (const state of this.state.values()) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }

    // Let an in-flight sweep finish rather than truncating it mid-batch.
    const deadline = Date.now() + 5_000;
    while (this.anyRunning() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }

  private anyRunning(): boolean {
    for (const state of this.state.values()) {
      if (state.running) {
        return true;
      }
    }
    return false;
  }
}
