import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@akai/observability";
import { OutboxDispatcher } from "./outbox.dispatcher";
import { OutboxRunner } from "./outbox.runner";
import type { OutboxDispatchSummary } from "./outbox.dispatcher";
import type { OutboxHandler } from "./outbox.types";

const EMPTY_SUMMARY: OutboxDispatchSummary = {
  claimed: 0,
  processed: 0,
  retried: 0,
  dead: 0,
};

function fakeLogger(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

interface FakeDispatcher {
  readonly dispatchDue: ReturnType<typeof vi.fn>;
  readonly registerAll: ReturnType<typeof vi.fn>;
  readonly registeredTopics: ReturnType<typeof vi.fn>;
}

function fakeDispatcher(
  dispatchImpl: () => Promise<OutboxDispatchSummary>,
): FakeDispatcher {
  return {
    dispatchDue: vi.fn(dispatchImpl),
    registerAll: vi.fn(),
    registeredTopics: vi.fn(() => ["email"]),
  };
}

function buildRunner(
  dispatcher: FakeDispatcher,
  handlers: readonly OutboxHandler[] = [],
  intervalMs = 1_000,
): OutboxRunner {
  return new OutboxRunner(
    dispatcher as unknown as OutboxDispatcher,
    handlers,
    intervalMs,
    fakeLogger(),
  );
}

describe("OutboxRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers handlers on start", () => {
    const handler: OutboxHandler = { topic: "email", handle: () => Promise.resolve() };
    const dispatcher = fakeDispatcher(() => Promise.resolve(EMPTY_SUMMARY));
    const runner = buildRunner(dispatcher, [handler]);

    runner.start();

    expect(dispatcher.registerAll).toHaveBeenCalledWith([handler]);
  });

  it("polls the dispatcher on each interval", async () => {
    const dispatcher = fakeDispatcher(() => Promise.resolve(EMPTY_SUMMARY));
    const runner = buildRunner(dispatcher, [], 1_000);

    runner.start();
    expect(dispatcher.dispatchDue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatcher.dispatchDue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatcher.dispatchDue).toHaveBeenCalledTimes(2);
  });

  it("stops polling after shutdown", async () => {
    const dispatcher = fakeDispatcher(() => Promise.resolve(EMPTY_SUMMARY));
    const runner = buildRunner(dispatcher, [], 1_000);

    runner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatcher.dispatchDue).toHaveBeenCalledTimes(1);

    await runner.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatcher.dispatchDue).toHaveBeenCalledTimes(1);
  });

  it("keeps polling after a tick throws", async () => {
    let calls = 0;
    const dispatcher = fakeDispatcher(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("DB down"));
      }
      return Promise.resolve(EMPTY_SUMMARY);
    });
    const runner = buildRunner(dispatcher, [], 1_000);

    runner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(dispatcher.dispatchDue).toHaveBeenCalledTimes(2);
  });

  it("is idempotent on repeated start()", () => {
    const dispatcher = fakeDispatcher(() => Promise.resolve(EMPTY_SUMMARY));
    const runner = buildRunner(dispatcher, []);

    runner.start();
    runner.start();

    expect(dispatcher.registerAll).toHaveBeenCalledTimes(1);
  });
});
