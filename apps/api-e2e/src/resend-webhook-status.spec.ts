import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";

import { ResendWebhookService } from "../../api/src/modules/email/webhook/resend-webhook.service";
import type { ResendWebhookEnvelope } from "../../api/src/modules/email/webhook/resend-webhook.schemas";
import { EmailService } from "../../api/src/modules/email/email.service";
import {
  DEFAULT_EMAIL_RETRY_POLICY,
  EMAIL_RETRY_POLICY,
  EMAIL_SLEEPER,
  EMAIL_TRANSPORT,
} from "../../api/src/modules/email/email.port";
import { InMemoryEmailTransport } from "../../api/src/modules/email/adapters/in-memory.transport";
import { PrismaService } from "../../api/src/modules/prisma/prisma.service";
import { LOGGER } from "../../api/src/modules/observability/logger.module";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * Delivery status, against a real Postgres.
 *
 * Two of the guarantees here are TRANSACTIONAL and cannot be shown with a fake:
 * the dedupe insert shares a transaction with the status change, and the
 * monotonic guard reads the current row inside it. A fake client would model
 * both and prove neither.
 *
 * The third is ordering. Provider events arrive out of order — Resend retries on
 * any non-2xx, and `email.sent` can land after `email.delivered` — so a
 * transition is applied only when it moves the delivery FORWARD.
 */

const RUN = isDockerAvailable();

describe.skipIf(!RUN)("Resend delivery status (real Postgres)", () => {
  let db: TestDatabase;
  let service: ResendWebhookService;
  /**
   * The REAL send path, against the same database the webhook writes to.
   *
   * The suppression guard is only worth anything if the row the webhook writes
   * is the row `EmailService.checkSuppression` reads. A fake on either side
   * would let the two drift on column name, citext-ness or shape and still go
   * green, which is exactly how this defect survived: the model existed, the
   * read existed, and nothing joined them.
   */
  let emails: EmailService;
  let transport: InMemoryEmailTransport;

  beforeAll(async () => {
    db = await startTestDatabase();
    service = new ResendWebhookService(db.prisma);

    transport = new InMemoryEmailTransport();
    const moduleRef = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: EMAIL_TRANSPORT, useValue: transport },
        { provide: LOGGER, useValue: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
        { provide: EMAIL_SLEEPER, useValue: async () => undefined },
        { provide: EMAIL_RETRY_POLICY, useValue: DEFAULT_EMAIL_RETRY_POLICY },
      ],
    }).compile();
    emails = moduleRef.get(EmailService);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  afterEach(async () => {
    await db.reset();
    transport.reset();
  });

  const MESSAGE_ID = "re_abc123";
  const RECIPIENT = "buyer@akai.test";

  async function seedEvent(status: string, providerMessageId: string | null = MESSAGE_ID) {
    return db.prisma.emailEvent.create({
      data: {
        recipient: RECIPIENT,
        templateKey: "order-confirmation",
        locale: "es",
        status: status as never,
        providerMessageId,
        attempts: 1,
      },
    });
  }

  function envelope(type: string, overrides: Partial<{ bounce: unknown }> = {}) {
    return {
      type,
      data: {
        email_id: MESSAGE_ID,
        ...(overrides.bounce === undefined ? {} : { bounce: overrides.bounce }),
      },
    } as ResendWebhookEnvelope;
  }

  async function statusOf(id: string): Promise<string> {
    const row = await db.prisma.emailEvent.findUniqueOrThrow({ where: { id } });
    return row.status;
  }

  it("advances SENT to DELIVERED", async () => {
    const event = await seedEvent("SENT");
    const outcome = await service.apply(envelope("email.delivered"), "evt_1");

    expect(outcome.status).toBe("applied");
    expect(await statusOf(event.id)).toBe("DELIVERED");
  });

  it("records a bounce WITH the provider's reason", async () => {
    const event = await seedEvent("SENT");
    await service.apply(
      envelope("email.bounced", {
        bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" },
      }),
      "evt_2",
    );

    const row = await db.prisma.emailEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe("BOUNCED");
    // The only thing that explains the bounce to an operator.
    expect(row.error).toContain("mailbox does not exist");
  });

  it("lets a COMPLAINT override a delivery, because it happens afterwards", async () => {
    const event = await seedEvent("DELIVERED");
    const outcome = await service.apply(envelope("email.complained"), "evt_3");

    expect(outcome.status).toBe("applied");
    expect(await statusOf(event.id)).toBe("COMPLAINED");
  });

  describe("out-of-order delivery", () => {
    it("does NOT regress DELIVERED back to SENT", async () => {
      const event = await seedEvent("DELIVERED");
      const outcome = await service.apply(envelope("email.sent"), "evt_4");

      expect(outcome.status).toBe("stale");
      expect(await statusOf(event.id)).toBe("DELIVERED");
    });

    it("does NOT regress a BOUNCE back to DELIVERED", async () => {
      const event = await seedEvent("BOUNCED");
      const outcome = await service.apply(envelope("email.delivered"), "evt_5");

      expect(outcome.status).toBe("stale");
      expect(await statusOf(event.id)).toBe("BOUNCED");
    });
  });

  describe("idempotency", () => {
    it("applies the SAME event id only once", async () => {
      const event = await seedEvent("SENT");
      const first = await service.apply(envelope("email.delivered"), "evt_dup");
      const second = await service.apply(envelope("email.delivered"), "evt_dup");

      expect(first.status).toBe("applied");
      // Resend retries on any non-2xx; without dedupe a slow handler would
      // re-apply the same outcome on every retry.
      expect(second.status).toBe("duplicate");
      expect(await statusOf(event.id)).toBe("DELIVERED");
    });

    it("still records the event id when nothing matched, so retries stop", async () => {
      const first = await service.apply(envelope("email.delivered"), "evt_unmatched");
      const second = await service.apply(envelope("email.delivered"), "evt_unmatched");

      expect(first.status).toBe("unmatched");
      expect(second.status).toBe("duplicate");
    });
  });

  it("ignores engagement events rather than overwriting the status", async () => {
    const event = await seedEvent("DELIVERED");
    // An open is not a delivery outcome; folding it into `status` would replace
    // DELIVERED with something that says strictly less.
    const outcome = await service.apply(envelope("email.opened"), "evt_6");

    expect(outcome.status).toBe("ignored");
    expect(await statusOf(event.id)).toBe("DELIVERED");
  });

  it("does not touch rows belonging to a different message", async () => {
    const mine = await seedEvent("SENT");
    const other = await seedEvent("SENT", "re_someone_else");

    await service.apply(envelope("email.bounced"), "evt_7");

    expect(await statusOf(mine.id)).toBe("BOUNCED");
    expect(await statusOf(other.id)).toBe("SENT");
  });

  /**
   * SUPPRESSION — the point of recording a bounce at all.
   *
   * `email_suppression` is READ before every customer send, and until this
   * existed nothing in the repository ever wrote a row: the guard was inert and
   * the system kept mailing dead addresses, which costs sending reputation for
   * every other customer's order confirmation.
   */
  describe("suppression", () => {
    async function suppressionFor(email: string) {
      return db.prisma.emailSuppression.findUnique({ where: { email } });
    }

    const HARD_BOUNCE = {
      bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" },
    };
    const SOFT_BOUNCE = {
      bounce: { type: "Transient", subType: "MailboxFull", message: "over quota" },
    };

    it("suppresses the recipient on a HARD bounce", async () => {
      await seedEvent("SENT");
      await service.apply(envelope("email.bounced", HARD_BOUNCE), "evt_sup_hard");

      const row = await suppressionFor(RECIPIENT);
      expect(row).not.toBeNull();
      expect(row?.reason).toContain("bounce");
    });

    it("suppresses the recipient on a COMPLAINT", async () => {
      await seedEvent("DELIVERED");
      await service.apply(envelope("email.complained"), "evt_sup_complaint");

      const row = await suppressionFor(RECIPIENT);
      expect(row).not.toBeNull();
      expect(row?.reason).toContain("omplaint");
    });

    it("does NOT suppress on a TRANSIENT bounce", async () => {
      const event = await seedEvent("SENT");
      await service.apply(envelope("email.bounced", SOFT_BOUNCE), "evt_sup_soft");

      // The status still moves — the message really did bounce — but a full
      // mailbox empties, and permanently blackholing a paying customer over a
      // transient condition is worse than one more delivery attempt.
      expect(await statusOf(event.id)).toBe("BOUNCED");
      expect(await suppressionFor(RECIPIENT)).toBeNull();
    });

    it("does NOT suppress when the provider gave no bounce classification", async () => {
      await seedEvent("SENT");
      await service.apply(envelope("email.bounced"), "evt_sup_unknown");

      // An unclassified bounce is not evidence the mailbox is dead.
      expect(await suppressionFor(RECIPIENT)).toBeNull();
    });

    it("survives a SECOND hard bounce for an address already suppressed", async () => {
      await seedEvent("SENT");
      await service.apply(envelope("email.bounced", HARD_BOUNCE), "evt_sup_first");
      const first = await suppressionFor(RECIPIENT);

      // A distinct svix id, so dedupe does not hide the second write. `email`
      // is the PRIMARY KEY, so a naive insert would raise a unique violation
      // here and turn a routine repeat bounce into a 500 and a retry storm.
      const outcome = await service.apply(envelope("email.bounced", HARD_BOUNCE), "evt_sup_second");

      expect(outcome.status).not.toBe("duplicate");
      const second = await suppressionFor(RECIPIENT);
      expect(second).not.toBeNull();
      // The FIRST suppression is the fact worth keeping; a repeat must not
      // silently reset when the address was first known bad.
      expect(second?.createdAt.toISOString()).toBe(first?.createdAt.toISOString());
    });

    it("writes no suppression for an event that matches no message", async () => {
      const outcome = await service.apply(envelope("email.bounced", HARD_BOUNCE), "evt_sup_orphan");

      expect(outcome.status).toBe("unmatched");
      expect(await suppressionFor(RECIPIENT)).toBeNull();
    });

    /**
     * THE WHOLE POINT: the row the webhook writes must be the row the send path
     * refuses to mail past. Asserted through the real `EmailService` against the
     * same database, because a fake on either side proves only that two fakes
     * agree with each other.
     */
    it("stops the NEXT customer send to that address", async () => {
      await seedEvent("SENT");
      await service.apply(envelope("email.bounced", HARD_BOUNCE), "evt_sup_guard");

      const result = await emails.send({
        templateKey: "contact-autoreply",
        to: RECIPIENT,
        locale: "es",
        payload: { name: "Marta", subject: "Pedido", referenceId: "ref-1" },
      });

      expect(result.status).toBe("suppressed");
      expect(transport.to(RECIPIENT)).toHaveLength(0);
    });

    it("still delivers a SUPPRESSION-EXEMPT template to that address", async () => {
      await seedEvent("SENT");
      await service.apply(envelope("email.bounced", HARD_BOUNCE), "evt_sup_exempt");

      // `reset-password` is exempt on purpose (email.templates.ts): the user is
      // actively waiting for it, and a bounce entry must not lock them out of
      // their own account. Writing suppressions must not change that.
      const result = await emails.send({
        templateKey: "reset-password",
        to: RECIPIENT,
        locale: "es",
        payload: {
          firstName: "Marta",
          resetUrl: "https://akai.shop/reset?token=abc",
          expiresInMinutes: 30,
        },
      });

      expect(result.status).toBe("sent");
      expect(transport.to(RECIPIENT)).toHaveLength(1);
    });
  });
});
