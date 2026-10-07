import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";
import { OutboxAuthEventPublisher } from "./outbox-auth-event.publisher";
import type { AuthDomainEvent } from "./auth-events.port";
import type { PrismaService } from "../../prisma/prisma.service";
import { parseTemplatePayload } from "../../email/email.templates";

const CONFIG = {
  DASHBOARD_URL: "https://dash.akai.test/",
  STOREFRONT_URL: "https://shop.akai.test/",
} as unknown as ServerEnv;

interface CreateArgs {
  readonly data: {
    readonly topic: string;
    readonly payload: {
      readonly templateKey: string;
      readonly to: string;
      readonly payload: Record<string, unknown>;
    };
  };
}

function build(): {
  publisher: OutboxAuthEventPublisher;
  create: ReturnType<typeof vi.fn>;
  logCalls: unknown[][];
} {
  const create = vi.fn(async () => ({}));
  const prisma = { outboxMessage: { create } } as unknown as PrismaService;
  const logCalls: unknown[][] = [];
  const record = (...args: unknown[]): void => {
    logCalls.push(args);
  };
  const logger = { info: record, warn: record, error: record, debug: record } as unknown as Logger;
  return { publisher: new OutboxAuthEventPublisher(prisma, CONFIG, logger), create, logCalls };
}

const OCCURRED = new Date("2026-07-20T10:00:00.000Z");

describe("OutboxAuthEventPublisher — verification", () => {
  it("enqueues a schema-valid verify-email row carrying the token in the link", async () => {
    const { publisher, create } = build();
    const event: AuthDomainEvent = {
      type: "auth.customer.registered",
      customerId: "c-1",
      email: "buyer@example.com",
      occurredAt: OCCURRED,
      verificationToken: "tok-abc-123",
      expiresAt: new Date(OCCURRED.getTime() + 24 * 60 * 60 * 1000),
    };

    await publisher.publish(event);

    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]?.[0] as CreateArgs;
    expect(args.data.topic).toBe("email");
    expect(args.data.payload.templateKey).toBe("verify-email");
    expect(args.data.payload.to).toBe("buyer@example.com");
    // Spanish only: the row names no language, and the link has no locale prefix.
    expect(args.data.payload).not.toHaveProperty("locale");

    const parsed = parseTemplatePayload("verify-email", args.data.payload.payload);
    expect(parsed.verifyUrl).toBe(
      "https://dash.akai.test/verify-email?token=tok-abc-123",
    );
    expect(parsed.expiresInHours).toBe(24);
    expect(parsed.firstName).toBe("buyer");
  });
});

describe("OutboxAuthEventPublisher — password reset", () => {
  it("enqueues a schema-valid reset-password row with minutes-to-expiry", async () => {
    const { publisher, create } = build();
    await publisher.publish({
      type: "auth.password_reset.requested",
      customerId: "c-1",
      email: "buyer@example.com",
      occurredAt: OCCURRED,
      resetToken: "reset-xyz",
      expiresAt: new Date(OCCURRED.getTime() + 30 * 60 * 1000),
    });

    const args = create.mock.calls[0]?.[0] as CreateArgs;
    expect(args.data.payload.templateKey).toBe("reset-password");
    const parsed = parseTemplatePayload("reset-password", args.data.payload.payload);
    expect(parsed.resetUrl).toBe(
      "https://dash.akai.test/reset-password?token=reset-xyz",
    );
    expect(parsed.expiresInMinutes).toBe(30);
  });
});

describe("OutboxAuthEventPublisher — non-templated events", () => {
  it("does not enqueue an email for an event without a template", async () => {
    const { publisher, create } = build();
    await publisher.publish({
      type: "auth.password.changed",
      customerId: "c-1",
      email: "buyer@example.com",
      occurredAt: OCCURRED,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("never writes the raw token into a log line", async () => {
    const { publisher, logCalls } = build();
    await publisher.publish({
      type: "auth.password_reset.requested",
      customerId: "c-1",
      email: "buyer@example.com",
      occurredAt: OCCURRED,
      resetToken: "super-secret-token",
      expiresAt: new Date(OCCURRED.getTime() + 30 * 60 * 1000),
    });
    const serialized = JSON.stringify(logCalls);
    expect(serialized).not.toContain("super-secret-token");
  });
});

/**
 * WHERE THE EMAILED LINK POINTS.
 *
 * `authBase` was hard-coded to DASHBOARD_URL ("auth lives in the dashboard"), so
 * a customer who registered in the SHOP was mailed an `app.` link and left the
 * shop to confirm an address. The event now names its origin, and an absent one
 * still means the dashboard so no existing emitter changes behaviour.
 */
describe("OutboxAuthEventPublisher — link origin", () => {
  it("points a storefront registration at STOREFRONT_URL", async () => {
    const { publisher, create } = build();
    await publisher.publish({
      type: "auth.customer.registered",
      customerId: "c-1",
      email: "buyer@example.com",
      origin: "storefront",
      occurredAt: OCCURRED,
      verificationToken: "shop-token",
      expiresAt: new Date(OCCURRED.getTime() + 24 * 60 * 60 * 1000),
    });

    const args = create.mock.calls[0]?.[0] as CreateArgs;
    const parsed = parseTemplatePayload("verify-email", args.data.payload.payload);
    expect(parsed.verifyUrl).toBe("https://shop.akai.test/verify-email?token=shop-token");
  });

  it("sends a storefront password reset to the storefront as well", async () => {
    const { publisher, create } = build();
    await publisher.publish({
      type: "auth.password_reset.requested",
      customerId: "c-1",
      email: "buyer@example.com",
      origin: "storefront",
      occurredAt: OCCURRED,
      resetToken: "r1",
      expiresAt: new Date(OCCURRED.getTime() + 30 * 60 * 1000),
    });

    const args = create.mock.calls[0]?.[0] as CreateArgs;
    const parsed = parseTemplatePayload("reset-password", args.data.payload.payload);
    expect(parsed.resetUrl).toBe("https://shop.akai.test/reset-password?token=r1");
  });

  it("DEFAULTS an origin-less event to the dashboard, unchanged", async () => {
    // Every emitter in AuthService today omits `origin`. This is the assertion
    // that says adding the field changed nothing for them.
    const { publisher, create } = build();
    await publisher.publish({
      type: "auth.customer.registered",
      customerId: "c-1",
      email: "buyer@example.com",
      occurredAt: OCCURRED,
      verificationToken: "legacy",
      expiresAt: new Date(OCCURRED.getTime() + 24 * 60 * 60 * 1000),
    });

    const args = create.mock.calls[0]?.[0] as CreateArgs;
    const parsed = parseTemplatePayload("verify-email", args.data.payload.payload);
    expect(parsed.verifyUrl).toBe("https://dash.akai.test/verify-email?token=legacy");
  });

  it("names an explicit dashboard origin at DASHBOARD_URL", async () => {
    const { publisher, create } = build();
    await publisher.publish({
      type: "auth.email_verification.requested",
      customerId: "c-1",
      email: "buyer@example.com",
      origin: "dashboard",
      occurredAt: OCCURRED,
      verificationToken: "d1",
      expiresAt: new Date(OCCURRED.getTime() + 60 * 60 * 1000),
    });

    const args = create.mock.calls[0]?.[0] as CreateArgs;
    const parsed = parseTemplatePayload("verify-email", args.data.payload.payload);
    expect(parsed.verifyUrl).toBe("https://dash.akai.test/verify-email?token=d1");
  });
});
