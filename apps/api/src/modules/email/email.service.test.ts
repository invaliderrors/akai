import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMinor } from "@akai/money";
import type { Locale } from "@akai/contracts";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import { InMemoryEmailTransport } from "./adapters/in-memory.transport";
import {
  EMAIL_RETRY_POLICY,
  EMAIL_SLEEPER,
  EMAIL_TRANSPORT,
  EmailDeliveryError,
  type EmailRetryPolicy,
} from "./email.port";
import { EmailService } from "./email.service";
import type { EmailPayloadFor } from "./email.templates";

// ---------------------------------------------------------------------------
// A fake Prisma that reproduces the ONE database behaviour this service
// depends on for correctness: the unique index on (orderId, templateKey), with
// Postgres' NULL semantics. Everything else is incidental storage.
// ---------------------------------------------------------------------------

interface StoredEvent {
  id: string;
  recipient: string;
  templateKey: string;
  locale: string;
  status: string;
  providerMessageId: string | null;
  orderId: string | null;
  dedupeScope: string;
  error: string | null;
  attempts: number;
  sentAt: Date | null;
  createdAt: Date;
}

interface CreateArgs {
  data: {
    recipient: string;
    templateKey: string;
    locale: string;
    orderId: string | null;
    /**
     * NOT NULL in the DB with a '' default. Typed as a required string here so
     * a service that forgets to pass it is a COMPILE error in this fake, rather
     * than an undefined that silently reproduces the old two-column key.
     */
    dedupeScope: string;
    status: string;
    attempts: number;
  };
}

interface UpdateArgs {
  where: { id: string };
  data: {
    status?: string;
    providerMessageId?: string;
    attempts?: number;
    sentAt?: Date;
    error?: string | null;
  };
}

class UniqueViolation extends Error {
  readonly code = "P2002";
}

class FakePrisma {
  readonly events: StoredEvent[] = [];
  readonly suppressions = new Map<string, string>();

  /** Arm a hard failure on the claiming insert, to test the no-row path. */
  createShouldFail: Error | null = null;
  suppressionShouldFail: Error | null = null;

  private sequence = 0;

  readonly emailEvent = {
    create: async (args: CreateArgs): Promise<{ id: string }> => {
      if (this.createShouldFail !== null) {
        throw this.createShouldFail;
      }

      // Postgres: a UNIQUE index does NOT collide on NULL. Reproduced exactly,
      // because the service's documented behaviour depends on it. The key is
      // the THREE-column one now — (orderId, templateKey, dedupeScope) — so a
      // per-parcel scope is genuinely a distinct row here too.
      if (args.data.orderId !== null) {
        const clash = this.events.some(
          (event) =>
            event.orderId === args.data.orderId &&
            event.templateKey === args.data.templateKey &&
            event.dedupeScope === args.data.dedupeScope,
        );
        if (clash) {
          throw new UniqueViolation("Unique constraint failed");
        }
      }

      this.sequence += 1;
      const id = `event-${this.sequence}`;
      this.events.push({
        id,
        recipient: args.data.recipient,
        templateKey: args.data.templateKey,
        locale: args.data.locale,
        status: args.data.status,
        providerMessageId: null,
        orderId: args.data.orderId,
        dedupeScope: args.data.dedupeScope,
        error: null,
        attempts: args.data.attempts,
        sentAt: null,
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
      });
      return { id };
    },

    update: async (args: UpdateArgs): Promise<{ id: string }> => {
      const event = this.events.find((candidate) => candidate.id === args.where.id);
      if (event === undefined) {
        throw new Error("No such event");
      }
      if (args.data.status !== undefined) event.status = args.data.status;
      if (args.data.providerMessageId !== undefined)
        event.providerMessageId = args.data.providerMessageId;
      if (args.data.attempts !== undefined) event.attempts = args.data.attempts;
      if (args.data.sentAt !== undefined) event.sentAt = args.data.sentAt;
      if (args.data.error !== undefined) event.error = args.data.error;
      return { id: event.id };
    },

    findUnique: async (args: { where: { id: string } }): Promise<StoredEvent | null> =>
      this.events.find((event) => event.id === args.where.id) ?? null,
  };

  readonly emailSuppression = {
    findUnique: async (args: {
      where: { email: string };
    }): Promise<{ reason: string } | null> => {
      if (this.suppressionShouldFail !== null) {
        throw this.suppressionShouldFail;
      }
      const reason = this.suppressions.get(args.where.email);
      return reason === undefined ? null : { reason };
    },
  };

  find(id: string): StoredEvent | undefined {
    return this.events.find((event) => event.id === id);
  }
}

const FAST_RETRY: EmailRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  factor: 4,
  maxDelayMs: 5_000,
};

interface Harness {
  service: EmailService;
  prisma: FakePrisma;
  transport: InMemoryEmailTransport;
  sleep: ReturnType<typeof vi.fn>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

async function buildHarness(policy: EmailRetryPolicy = FAST_RETRY): Promise<Harness> {
  const prisma = new FakePrisma();
  const transport = new InMemoryEmailTransport();
  const sleep = vi.fn(async () => undefined);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      EmailService,
      { provide: PrismaService, useValue: prisma },
      { provide: EMAIL_TRANSPORT, useValue: transport },
      { provide: LOGGER, useValue: logger },
      { provide: EMAIL_SLEEPER, useValue: sleep },
      { provide: EMAIL_RETRY_POLICY, useValue: policy },
    ],
  }).compile();

  return { service: moduleRef.get(EmailService), prisma, transport, sleep, logger };
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function orderConfirmation(): EmailPayloadFor<"order-confirmation"> {
  return {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    placedAt: "2026-07-20T10:00:00.000Z",
    lines: [
      {
        name: "Creatine Monohydrate",
        variantName: "300 g",
        quantity: 2,
        unitPrice: { amount: toMinor(2499), currency: "EUR" },
        lineTotal: { amount: toMinor(4998), currency: "EUR" },
      },
    ],
    subtotal: { amount: toMinor(4998), currency: "EUR" },
    discountTotal: { amount: toMinor(0), currency: "EUR" },
    shippingTotal: { amount: toMinor(495), currency: "EUR" },
    taxTotal: { amount: toMinor(951), currency: "EUR" },
    grandTotal: { amount: toMinor(5493), currency: "EUR" },
    orderUrl: "https://akai.shop/orders/AK-2026-000123",
  };
}

function shippingConfirmation(): EmailPayloadFor<"shipping-confirmation"> {
  return {
    firstName: "Marta",
    orderNumber: "AK-2026-000123",
    carrier: "SEUR",
    trackingNumber: "SE123456789ES",
    trackingUrl: "https://seur.com/track/SE123456789ES",
    shippedAt: "2026-07-21T09:00:00.000Z",
    orderUrl: "https://akai.shop/orders/AK-2026-000123",
    lines: orderConfirmation().lines,
  };
}

function resetPassword(): EmailPayloadFor<"reset-password"> {
  return {
    firstName: "Marta",
    resetUrl: "https://akai.shop/reset?token=abc",
    expiresInMinutes: 30,
  };
}

const LOCALE: Locale = "es";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const SHIPMENT_A = "22222222-2222-4222-8222-222222222201";
const SHIPMENT_B = "22222222-2222-4222-8222-222222222202";

describe("EmailService — idempotency", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("sends an order confirmation once and dedupes the retry", async () => {
    const request = {
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    } as const;

    const first = await harness.service.send(request);
    const second = await harness.service.send(request);

    expect(first.status).toBe("sent");
    expect(second.status).toBe("duplicate");

    // THE assertion this module exists for: a provider webhook retry must not
    // mail the customer a second order confirmation.
    expect(harness.transport.messages).toHaveLength(1);
    expect(harness.prisma.events).toHaveLength(1);
  });

  it("claims the row BEFORE calling the provider, so a crash leaves evidence", async () => {
    harness.transport.failNext(3);

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.status).toBe("failed");
    // The row exists even though nothing was ever delivered — a send that
    // vanishes without a trace is undiagnosable.
    expect(harness.prisma.events).toHaveLength(1);
    expect(harness.prisma.events[0]?.status).toBe("FAILED");
  });

  it("does NOT dedupe mail that carries no order id", async () => {
    // Postgres UNIQUE does not collide on NULL, and that is the CORRECT
    // semantic here: a customer may legitimately request two password resets
    // in a row, and blocking the second would lock them out.
    const request = {
      templateKey: "reset-password",
      to: "marta@example.com",
      locale: LOCALE,
      payload: resetPassword(),
    } as const;

    const first = await harness.service.send(request);
    const second = await harness.service.send(request);

    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(harness.transport.messages).toHaveLength(2);
  });

  it("treats different templates for the same order as distinct sends", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";

    const confirmation = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId,
    });
    const shipping = await harness.service.send({
      templateKey: "shipping-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: shippingConfirmation(),
      orderId,
      dedupeScope: SHIPMENT_A,
    });

    expect(confirmation.status).toBe("sent");
    expect(shipping.status).toBe("sent");
    expect(harness.transport.messages).toHaveLength(2);
  });
});

describe("EmailService — resilience", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("never throws when the provider is down", async () => {
    harness.transport.failNext(3);

    // The property that protects the payment flow: a Resend outage must not
    // turn a captured payment into a 500 the customer retries.
    await expect(
      harness.service.send({
        templateKey: "order-confirmation",
        to: "marta@example.com",
        locale: LOCALE,
        payload: orderConfirmation(),
        orderId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("never throws when the database rejects the claiming insert", async () => {
    harness.prisma.createShouldFail = new Error("connection terminated");

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toMatchObject({ status: "failed", eventId: null });
    // Crucially it does NOT send unguarded: without the claim row there is no
    // idempotency, and a webhook retry would produce a duplicate.
    expect(harness.transport.messages).toHaveLength(0);
  });

  it("retries transient failures with exponential backoff, then succeeds", async () => {
    harness.transport.failNext(2);

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toMatchObject({ status: "sent", attempts: 3 });
    expect(harness.sleep).toHaveBeenCalledTimes(2);
    expect(harness.sleep).toHaveBeenNthCalledWith(1, 250);
    expect(harness.sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("caps the backoff at maxDelayMs", async () => {
    const harnessWithLongLadder = await buildHarness({
      maxAttempts: 4,
      baseDelayMs: 1_000,
      factor: 10,
      maxDelayMs: 5_000,
    });
    harnessWithLongLadder.transport.failNext(3);

    await harnessWithLongLadder.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(harnessWithLongLadder.sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(harnessWithLongLadder.sleep).toHaveBeenNthCalledWith(2, 5_000);
    expect(harnessWithLongLadder.sleep).toHaveBeenNthCalledWith(3, 5_000);
  });

  it("does NOT retry a permanent failure", async () => {
    harness.transport.failPermanently("Invalid recipient address");

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.status).toBe("failed");
    // Burning the retry budget on a 4xx only delays the DLQ signal an operator
    // needs; no sleep means no wasted attempts.
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it("still reports success when the provider accepted but the log update fails", async () => {
    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.status).toBe("sent");

    // Simulate the update failing on a subsequent send: the mail is already
    // gone, so losing the log line must not manufacture a failure.
    const failing = await buildHarness();
    failing.prisma.emailEvent.update = async () => {
      throw new Error("write conflict");
    };

    const second = await failing.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "22222222-2222-4222-8222-222222222222",
    });

    expect(second.status).toBe("sent");
    expect(failing.logger.error).toHaveBeenCalled();
  });

  it("sendInBackground returns immediately and swallows failure", async () => {
    harness.transport.failPermanently();

    const returned: void = harness.service.sendInBackground({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(returned).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.prisma.events[0]?.status).toBe("FAILED");
  });
});

describe("EmailService — suppression", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
    harness.prisma.suppressions.set("bounced@example.com", "hard_bounce");
  });

  it("refuses to mail a suppressed address", async () => {
    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "bounced@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toMatchObject({ status: "suppressed", reason: "hard_bounce" });
    expect(harness.transport.messages).toHaveLength(0);
    // No claim row either — a suppressed send must not consume the
    // (orderId, templateKey) slot, or a later lift-and-retry would be deduped.
    expect(harness.prisma.events).toHaveLength(0);
  });

  it("still delivers account-recovery mail to a suppressed address", async () => {
    // A stale bounce entry must not permanently lock a user out of their own
    // account when they are actively waiting for the reset they just requested.
    const result = await harness.service.send({
      templateKey: "reset-password",
      to: "bounced@example.com",
      locale: LOCALE,
      payload: resetPassword(),
    });

    expect(result.status).toBe("sent");
  });

  it("still delivers internal staff alerts", async () => {
    const result = await harness.service.send({
      templateKey: "admin-new-order",
      to: "bounced@example.com",
      locale: LOCALE,
      payload: {
        orderNumber: "AK-2026-000123",
        customerEmail: "marta@example.com",
        itemCount: 2,
        grandTotal: { amount: toMinor(5493), currency: "EUR" },
        placedAt: "2026-07-20T10:00:00.000Z",
        adminUrl: "https://dashboard.akai.shop/admin/orders/AK-2026-000123",
      },
    });

    expect(result.status).toBe("sent");
  });

  it("fails OPEN when the suppression table is unreachable", async () => {
    harness.prisma.suppressionShouldFail = new Error("relation does not exist");

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    // One mail to a possibly-bounced address beats every order confirmation in
    // the system silently stopping.
    expect(result.status).toBe("sent");
    expect(harness.logger.error).toHaveBeenCalled();
  });
});

describe("EmailService — payload validation", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("rejects a payload that fails its template schema", async () => {
    const broken = { ...orderConfirmation(), orderNumber: "not-an-order-number" };

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: broken,
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.status).toBe("rejected");
    expect(harness.transport.messages).toHaveLength(0);
    expect(harness.prisma.events).toHaveLength(0);
    // Our bug, not the caller's — it must be alertable.
    expect(harness.logger.error).toHaveBeenCalled();
  });

  it("rejects an invalid recipient without touching the database", async () => {
    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "not-an-email",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.status).toBe("rejected");
    expect(harness.prisma.events).toHaveLength(0);
  });

  it("rejects unknown keys rather than silently dropping them", async () => {
    const smuggled = { ...orderConfirmation(), passwordHash: "$argon2id$leaked" };

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: smuggled,
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    // .strict() matters here: an unknown key spread in from an order aggregate
    // would otherwise be rendered into the mail and stored at the provider.
    expect(result.status).toBe("rejected");
    expect(harness.transport.messages).toHaveLength(0);
  });

  it("normalises the recipient to lower case before deduping", async () => {
    await harness.service.send({
      templateKey: "order-confirmation",
      to: "Marta@Example.COM",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(harness.prisma.events[0]?.recipient).toBe("marta@example.com");
  });
});

describe("EmailService — event log", () => {
  it("records provider id, attempt count and sentAt on success", async () => {
    const harness = await buildHarness();

    const result = await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.status).toBe("sent");
    const stored = harness.prisma.events[0];
    expect(stored?.status).toBe("SENT");
    expect(stored?.providerMessageId).toBe("in-memory-1");
    expect(stored?.attempts).toBe(1);
    expect(stored?.sentAt).toBeInstanceOf(Date);
    expect(stored?.error).toBeNull();
  });

  it("truncates a long failure reason to the column width", async () => {
    const harness = await buildHarness();
    harness.transport.failNext(
      3,
      new EmailDeliveryError("x".repeat(5_000), true, 503),
    );

    await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    // email_event.error is VarChar(1000); an untruncated write would make the
    // DRIVER throw inside the failure handler, losing the failure record.
    const stored = harness.prisma.events[0];
    expect(stored?.error?.length).toBeLessThanOrEqual(1000);
    expect(stored?.attempts).toBe(3);
  });
});

describe("EmailService — admin retry", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("refuses to retry an email that was already delivered", async () => {
    await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });
    const eventId = harness.prisma.events[0]?.id ?? "";

    // The unique constraint only guards duplicate INSERTS. Without this check,
    // an operator clicking retry on a delivered confirmation would mail the
    // customer a second one — defeating idempotency from the admin UI.
    await expect(
      harness.service.retryFailed(eventId, { ...orderConfirmation() }),
    ).rejects.toThrow(/already delivered/i);
    expect(harness.transport.messages).toHaveLength(1);
  });

  it("re-sends a failed email using the STORED template key", async () => {
    harness.transport.failNext(3);
    await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });
    const eventId = harness.prisma.events[0]?.id ?? "";

    const result = await harness.service.retryFailed(eventId, {
      ...orderConfirmation(),
    });

    expect(result.status).toBe("sent");
    expect(harness.prisma.events).toHaveLength(1);
    expect(harness.prisma.events[0]?.status).toBe("SENT");
    // Same row reused — a fresh insert would collide with the unique index and
    // the attempt history would be lost.
    expect(harness.transport.lastMessage?.to).toBe("marta@example.com");
  });

  it("rejects a retry payload that does not match the stored template", async () => {
    harness.transport.failNext(3);
    await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });
    const eventId = harness.prisma.events[0]?.id ?? "";

    // An operator cannot render an arbitrary template: the key comes from the
    // row, so a reset-password payload simply fails order-confirmation's schema.
    await expect(
      harness.service.retryFailed(eventId, { ...resetPassword() }),
    ).rejects.toThrow();
  });

  it("404s for an unknown event", async () => {
    await expect(
      harness.service.retryFailed("event-missing", {}),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses to retry to an address suppressed since the failure", async () => {
    harness.transport.failNext(3);
    await harness.service.send({
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: "11111111-1111-4111-8111-111111111111",
    });
    const eventId = harness.prisma.events[0]?.id ?? "";
    harness.prisma.suppressions.set("marta@example.com", "complaint");

    const result = await harness.service.retryFailed(eventId, {
      ...orderConfirmation(),
    });

    expect(result.status).toBe("suppressed");
    expect(harness.transport.messages).toHaveLength(0);
  });
});

/**
 * PER-PARCEL DEDUPE.
 *
 * `email_event` used to be unique on (orderId, templateKey), which reads as an
 * idempotency guarantee and is one — for every template that fires once per
 * order. For `shipping-confirmation` it is a DATA-LOSS bug: an order can ship in
 * several parcels, the second claim collides, `send` reports `duplicate`, and
 * the outbox handler counts `duplicate` as terminal SUCCESS. The customer is
 * never told about parcel two and nothing anywhere records a failure.
 *
 * The key is now (orderId, templateKey, dedupeScope) with a NOT NULL ''
 * sentinel. These tests pin BOTH halves: a scoped send is a distinct row, and an
 * unscoped one behaves exactly as it did before.
 */
describe("EmailService — per-parcel dedupe scope", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("sends one shipping confirmation PER PARCEL when each carries its shipment id", async () => {
    const first = await harness.service.send({
      templateKey: "shipping-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: shippingConfirmation(),
      orderId: ORDER_ID,
      dedupeScope: SHIPMENT_A,
    });
    const second = await harness.service.send({
      templateKey: "shipping-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: shippingConfirmation(),
      orderId: ORDER_ID,
      dedupeScope: SHIPMENT_B,
    });

    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    // THE regression this column exists for: parcel two actually arrives.
    expect(harness.transport.messages).toHaveLength(2);
    expect(harness.prisma.events.map((event) => event.dedupeScope)).toEqual([
      SHIPMENT_A,
      SHIPMENT_B,
    ]);
  });

  it("still dedupes a redelivery of the SAME parcel", async () => {
    const request = {
      templateKey: "shipping-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: shippingConfirmation(),
      orderId: ORDER_ID,
      dedupeScope: SHIPMENT_A,
    } as const;

    expect((await harness.service.send(request)).status).toBe("sent");
    expect((await harness.service.send(request)).status).toBe("duplicate");
    expect(harness.transport.messages).toHaveLength(1);
  });

  it("keeps every other template on the '' scope, bit-for-bit as before", async () => {
    const request = {
      templateKey: "order-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: orderConfirmation(),
      orderId: ORDER_ID,
    } as const;

    expect((await harness.service.send(request)).status).toBe("sent");
    expect((await harness.service.send(request)).status).toBe("duplicate");
    // NOT null: NULLs are DISTINCT for uniqueness in Postgres, so a nullable
    // scope would quietly let a second order confirmation through.
    expect(harness.prisma.events[0]?.dedupeScope).toBe("");
  });

  it("REFUSES an order-scoped shipping confirmation instead of swallowing parcel two", async () => {
    // Without this guard a producer that forgets the scope gets the OLD
    // behaviour back — silently, and only for orders that ship in two parcels.
    // Rejecting makes the handler throw, so it dead-letters visibly at
    // /admin/jobs rather than looking like a successful dedupe.
    const result = await harness.service.send({
      templateKey: "shipping-confirmation",
      to: "marta@example.com",
      locale: LOCALE,
      payload: shippingConfirmation(),
      orderId: ORDER_ID,
    });

    expect(result.status).toBe("rejected");
    expect(harness.transport.messages).toHaveLength(0);
    expect(harness.prisma.events).toHaveLength(0);
  });
});
