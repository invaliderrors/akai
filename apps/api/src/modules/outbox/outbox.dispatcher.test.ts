import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";

import type { Logger } from "@akai/observability";
import { OutboxDispatcher } from "./outbox.dispatcher";
import type { OutboxRepository } from "./outbox.repository";
import {
  DEFAULT_OUTBOX_POLICY,
  backoffMs,
  type OutboxHandler,
  type OutboxMessage,
  type OutboxPolicy,
} from "./outbox.types";

/** Records every repository call so the schedule can be asserted precisely. */
interface FailedCall {
  readonly id: string;
  readonly error: string;
  readonly availableAt: Date | null;
  readonly dead: boolean;
}

class FakeOutboxRepository implements OutboxRepository {
  private queue: OutboxMessage[] = [];
  readonly processed: string[] = [];
  readonly failed: FailedCall[] = [];

  seed(messages: readonly OutboxMessage[]): void {
    this.queue = [...messages];
  }

  // Trailing `now: Date` args from the interface are omitted where unused — a
  // narrower implementation still satisfies the wider port signature.
  claimDue(limit: number): Promise<readonly OutboxMessage[]> {
    const batch = this.queue.slice(0, limit);
    this.queue = this.queue.slice(limit);
    return Promise.resolve(batch);
  }

  markProcessed(id: string): Promise<void> {
    this.processed.push(id);
    return Promise.resolve();
  }

  markFailed(
    id: string,
    error: string,
    availableAt: Date | null,
    dead: boolean,
  ): Promise<void> {
    this.failed.push({ id, error, availableAt, dead });
    return Promise.resolve();
  }
}

function fakeLogger(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function message(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: overrides.id ?? "msg-1",
    topic: overrides.topic ?? "email",
    payload: overrides.payload ?? { hello: "world" },
    // Repository increments at claim time, so a just-claimed message is at 1.
    attempts: overrides.attempts ?? 1,
  };
}

function recordingHandler(
  topic: string,
  impl?: (payload: unknown) => Promise<void>,
): OutboxHandler & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    topic,
    calls,
    async handle(payload: unknown): Promise<void> {
      calls.push(payload);
      if (impl) {
        await impl(payload);
      }
    },
  };
}

const NOW = new Date("2026-07-20T12:00:00.000Z");

function buildDispatcher(
  repository: FakeOutboxRepository,
  policy: OutboxPolicy = DEFAULT_OUTBOX_POLICY,
): OutboxDispatcher {
  return new OutboxDispatcher(repository, policy, fakeLogger());
}

describe("OutboxDispatcher — routing", () => {
  let repository: FakeOutboxRepository;

  beforeEach(() => {
    repository = new FakeOutboxRepository();
  });

  it("routes a message to the handler registered for its topic and marks it processed", async () => {
    const email = recordingHandler("email");
    const dispatcher = buildDispatcher(repository);
    dispatcher.register(email);
    repository.seed([message({ id: "m1", topic: "email", payload: { to: "a@b.co" } })]);

    const summary = await dispatcher.dispatchDue(NOW);

    expect(email.calls).toEqual([{ to: "a@b.co" }]);
    expect(repository.processed).toEqual(["m1"]);
    expect(repository.failed).toEqual([]);
    expect(summary).toEqual({ claimed: 1, processed: 1, retried: 0, dead: 0 });
  });

  it("dispatches each message to the handler for its own topic", async () => {
    const email = recordingHandler("email");
    const sync = recordingHandler("provider-sync");
    const dispatcher = buildDispatcher(repository);
    dispatcher.registerAll([email, sync]);
    repository.seed([
      message({ id: "m1", topic: "email" }),
      message({ id: "m2", topic: "provider-sync" }),
    ]);

    await dispatcher.dispatchDue(NOW);

    expect(email.calls).toHaveLength(1);
    expect(sync.calls).toHaveLength(1);
    expect(repository.processed).toEqual(["m1", "m2"]);
  });

  it("treats a message with no registered handler as a failure, not a success", async () => {
    const dispatcher = buildDispatcher(repository);
    repository.seed([message({ id: "orphan", topic: "unmapped-topic" })]);

    const summary = await dispatcher.dispatchDue(NOW);

    // Marking it processed would silently drop the side effect forever; instead
    // it must be recorded as failed so it surfaces at /admin/jobs.
    expect(repository.processed).toEqual([]);
    expect(repository.failed).toHaveLength(1);
    expect(repository.failed[0]?.error).toContain("unmapped-topic");
    expect(summary.retried).toBe(1);
  });
});

describe("OutboxDispatcher — retry and dead-lettering", () => {
  let repository: FakeOutboxRepository;

  beforeEach(() => {
    repository = new FakeOutboxRepository();
  });

  it("reschedules a failed message with the policy backoff and does not mark it processed", async () => {
    const dispatcher = buildDispatcher(repository);
    dispatcher.register(
      recordingHandler("email", () => Promise.reject(new Error("Resend timeout"))),
    );
    repository.seed([message({ id: "m1", topic: "email", attempts: 2 })]);

    const summary = await dispatcher.dispatchDue(NOW);

    expect(repository.processed).toEqual([]);
    expect(repository.failed).toHaveLength(1);
    const call = repository.failed[0];
    expect(call?.dead).toBe(false);
    expect(call?.error).toContain("Resend timeout");
    const expectedDelay = backoffMs(2, DEFAULT_OUTBOX_POLICY);
    expect(call?.availableAt?.getTime()).toBe(NOW.getTime() + expectedDelay);
    expect(summary).toEqual({ claimed: 1, processed: 0, retried: 1, dead: 0 });
  });

  it("dead-letters a message once attempts reach the policy ceiling", async () => {
    const policy: OutboxPolicy = { ...DEFAULT_OUTBOX_POLICY, maxAttempts: 3 };
    const dispatcher = buildDispatcher(repository, policy);
    dispatcher.register(
      recordingHandler("email", () => Promise.reject(new Error("still failing"))),
    );
    repository.seed([message({ id: "m1", topic: "email", attempts: 3 })]);

    const summary = await dispatcher.dispatchDue(NOW);

    const call = repository.failed[0];
    expect(call?.dead).toBe(true);
    expect(call?.availableAt).toBeNull();
    expect(summary).toEqual({ claimed: 1, processed: 0, retried: 0, dead: 1 });
  });

  it("continues draining the batch after one message throws", async () => {
    const good = recordingHandler("email");
    const dispatcher = buildDispatcher(repository);
    dispatcher.register(good);
    dispatcher.register(
      recordingHandler("provider-sync", () => Promise.reject(new Error("boom"))),
    );
    repository.seed([
      message({ id: "bad", topic: "provider-sync" }),
      message({ id: "ok", topic: "email" }),
    ]);

    const summary = await dispatcher.dispatchDue(NOW);

    expect(repository.processed).toEqual(["ok"]);
    expect(summary).toEqual({ claimed: 2, processed: 1, retried: 1, dead: 0 });
  });
});

describe("OutboxDispatcher — registration", () => {
  it("rejects a second, different handler for the same topic", () => {
    const dispatcher = buildDispatcher(new FakeOutboxRepository());
    dispatcher.register(recordingHandler("email"));
    expect(() => dispatcher.register(recordingHandler("email"))).toThrow(/email/);
  });

  it("is idempotent when the SAME handler instance is registered twice", () => {
    const dispatcher = buildDispatcher(new FakeOutboxRepository());
    const handler = recordingHandler("email");
    dispatcher.register(handler);
    expect(() => dispatcher.register(handler)).not.toThrow();
    expect(dispatcher.registeredTopics()).toEqual(["email"]);
  });

  it("reports whether a topic has a handler", () => {
    const dispatcher = buildDispatcher(new FakeOutboxRepository());
    dispatcher.register(recordingHandler("email"));
    expect(dispatcher.hasHandler("email")).toBe(true);
    expect(dispatcher.hasHandler("provider-sync")).toBe(false);
  });
});
