import "reflect-metadata";
import { createLogger } from "@akai/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ScheduledJobsRunner,
  type CartSweeper,
  type PaymentReconciler,
  type ReservationSweeper,
  type ScheduledJobsIntervals,
} from "./scheduled-jobs.runner";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });

// Short, prime-ish cadences so the two jobs fire on distinct ticks and the
// assertions below read off a clean schedule.
const INTERVALS: ScheduledJobsIntervals = {
  reservationExpiryMs: 1_000,
  cartExpiryMs: 3_000,
  paymentReconciliationMs: 7_000,
};

const IDLE_PAYMENTS: PaymentReconciler = { reconcileStalledPayments: () => Promise.resolve(0) };

function makeRunner(
  reservations: ReservationSweeper,
  carts: CartSweeper,
  payments: PaymentReconciler = IDLE_PAYMENTS,
): ScheduledJobsRunner {
  return new ScheduledJobsRunner(reservations, carts, payments, INTERVALS, logger);
}

describe("ScheduledJobsRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes each sweep on its own cadence", async () => {
    const releaseExpired = vi.fn(() => Promise.resolve(0));
    const expireStaleCarts = vi.fn(() => Promise.resolve(0));
    const runner = makeRunner({ releaseExpired }, { expireStaleCarts });

    runner.start();

    // Nothing runs until the first interval elapses — this is the whole bug the
    // runner fixes: previously the sweeps were never called at all.
    expect(releaseExpired).not.toHaveBeenCalled();
    expect(expireStaleCarts).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(releaseExpired).toHaveBeenCalledTimes(1);
    expect(expireStaleCarts).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    // reservation-expiry (1s) has fired three times by t=3s; cart-expiry (3s) once.
    expect(releaseExpired).toHaveBeenCalledTimes(3);
    expect(expireStaleCarts).toHaveBeenCalledTimes(1);

    await runner.onApplicationShutdown();
  });

  it("runs the payment reconciliation on its own cadence", async () => {
    const reconcileStalledPayments = vi.fn(() => Promise.resolve(0));
    const runner = makeRunner(
      { releaseExpired: () => Promise.resolve(0) },
      { expireStaleCarts: () => Promise.resolve(0) },
      { reconcileStalledPayments },
    );

    runner.start();

    await vi.advanceTimersByTimeAsync(6_999);
    expect(reconcileStalledPayments).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcileStalledPayments).toHaveBeenCalledTimes(1);

    await runner.onApplicationShutdown();
  });

  it("keeps sweeping after a run throws", async () => {
    const releaseExpired = vi.fn(() => Promise.resolve(0));
    releaseExpired.mockRejectedValueOnce(new Error("database briefly unreachable"));
    const expireStaleCarts = vi.fn(() => Promise.resolve(0));
    const runner = makeRunner({ releaseExpired }, { expireStaleCarts });

    runner.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(releaseExpired).toHaveBeenCalledTimes(1); // this one rejected

    await vi.advanceTimersByTimeAsync(1_000);
    // A single failed sweep must not kill the loop; the next tick runs normally.
    expect(releaseExpired).toHaveBeenCalledTimes(2);

    await runner.onApplicationShutdown();
  });

  it("stops scheduling after shutdown", async () => {
    const releaseExpired = vi.fn(() => Promise.resolve(0));
    const expireStaleCarts = vi.fn(() => Promise.resolve(0));
    const runner = makeRunner({ releaseExpired }, { expireStaleCarts });

    runner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(releaseExpired).toHaveBeenCalledTimes(1);

    await runner.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(10_000);

    // No further runs once the process is draining.
    expect(releaseExpired).toHaveBeenCalledTimes(1);
  });

  it("start is idempotent so the cadence cannot be doubled", async () => {
    const releaseExpired = vi.fn(() => Promise.resolve(0));
    const expireStaleCarts = vi.fn(() => Promise.resolve(0));
    const runner = makeRunner({ releaseExpired }, { expireStaleCarts });

    runner.start();
    runner.start();

    await vi.advanceTimersByTimeAsync(1_000);
    // A second start() that re-scheduled would show two calls here.
    expect(releaseExpired).toHaveBeenCalledTimes(1);

    await runner.onApplicationShutdown();
  });
});
