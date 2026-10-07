import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { contactRequestSchema } from "@akai/contracts";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import type { PrismaService } from "../prisma/prisma.service";
import type { CaptchaVerifier } from "../auth/ports/captcha.port";
import type { Clock } from "../auth/ports/clock.port";
import { ContactService, deriveSubject } from "./contact.service";

const OPS_INBOX = "ops@akai.test";

/**
 * The outbox rows a submission produces, captured rather than written.
 *
 * `$transaction` is modelled as "collect the arguments", which is exactly the
 * property under test: the two rows must be created in ONE transaction, so
 * asserting they arrive as a single array is asserting the atomicity guarantee.
 */
interface RecordedRow {
  readonly topic: string;
  readonly payload: unknown;
}

class FakePrisma {
  readonly batches: RecordedRow[][] = [];

  readonly outboxMessage = {
    create: (args: { data: { topic: string; payload: unknown } }): RecordedRow => ({
      topic: args.data.topic,
      payload: args.data.payload,
    }),
  };

  $transaction(rows: RecordedRow[]): Promise<RecordedRow[]> {
    this.batches.push(rows);
    return Promise.resolve(rows);
  }
}

class FakeCaptcha implements CaptchaVerifier {
  readonly seen: { token: string; ip: string | null }[] = [];
  constructor(private readonly verdict: boolean) {}

  verify(token: string, remoteIp: string | null): Promise<boolean> {
    this.seen.push({ token, ip: remoteIp });
    return Promise.resolve(this.verdict);
  }
}

const clock: Clock = { now: () => new Date("2026-07-20T10:00:00.000Z") };

const warnings: unknown[] = [];
const logger = {
  info: () => undefined,
  warn: (context: unknown) => {
    warnings.push(context);
  },
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const config = { EMAIL_FROM: OPS_INBOX } as unknown as ServerEnv;

/** The envelope shape `EmailOutboxHandler`'s hydrated branch accepts. */
const envelopeSchema = z.object({
  templateKey: z.string(),
  to: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

function envelopesOf(prisma: FakePrisma): z.infer<typeof envelopeSchema>[] {
  const [batch = []] = prisma.batches;
  return batch.map((row) => envelopeSchema.parse(row.payload));
}

const SUBMISSION = contactRequestSchema.parse({
  name: "Marta",
  email: "marta@example.com",
  message: "Which lot is currently shipping for AK-CRE-300?\nThanks.",
  turnstileToken: "token-abc",
});

describe("ContactService.submit", () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = new FakePrisma();
    warnings.length = 0;
  });

  function serviceWith(captcha: CaptchaVerifier): ContactService {
    return new ContactService(
      prisma as unknown as PrismaService,
      captcha,
      clock,
      config,
      logger,
    );
  }

  it("accepts a submission and reports it as sent", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await expect(service.submit(SUBMISSION, "203.0.113.4")).resolves.toEqual({
      sent: true,
    });
  });

  it("queues BOTH mails in one transaction, never an inline transport call", () => {
    const service = serviceWith(new FakeCaptcha(true));

    return service.submit(SUBMISSION, null).then(() => {
      expect(prisma.batches).toHaveLength(1);
      expect(prisma.batches[0]).toHaveLength(2);
      expect(prisma.batches[0]?.every((row) => row.topic === "email")).toBe(true);
    });
  });

  it("sends the staff copy to the operations inbox, never to the submitter", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(SUBMISSION, null);
    const [staff] = envelopesOf(prisma);

    expect(staff?.templateKey).toBe("contact-received");
    expect(staff?.to).toBe(OPS_INBOX);
    expect(staff?.payload["replyTo"]).toBe("marta@example.com");
  });

  it("prefers CONTACT_INBOX_EMAIL over EMAIL_FROM when both are set", async () => {
    const supportInbox = "support@akai.test";
    const service = new ContactService(
      prisma as unknown as PrismaService,
      new FakeCaptcha(true),
      clock,
      { EMAIL_FROM: OPS_INBOX, CONTACT_INBOX_EMAIL: supportInbox } as unknown as ServerEnv,
      logger,
    );

    await service.submit(SUBMISSION, null);
    const [staff] = envelopesOf(prisma);

    expect(staff?.to).toBe(supportInbox);
    expect(staff?.to).not.toBe(OPS_INBOX);
  });

  it("acknowledges the submitter with the same reference id the team sees", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(SUBMISSION, null);
    const [staff, autoreply] = envelopesOf(prisma);

    expect(autoreply?.templateKey).toBe("contact-autoreply");
    expect(autoreply?.to).toBe("marta@example.com");
    expect(autoreply?.payload["referenceId"]).toBe(staff?.payload["referenceId"]);
  });

  it("names no language on the envelopes — every mail renders in Spanish", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(SUBMISSION, null);

    const [batch = []] = prisma.batches;
    expect(batch).toHaveLength(2);
    for (const row of batch) {
      expect(row.payload).not.toHaveProperty("locale");
    }
  });

  it("mints an unguessable, non-sequential reference", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(SUBMISSION, null);
    const first = envelopesOf(prisma)[0]?.payload["referenceId"];

    prisma.batches.length = 0;
    await service.submit(SUBMISSION, null);
    const second = envelopesOf(prisma)[0]?.payload["referenceId"];

    expect(first).toMatch(/^CT-[0-9A-F]{10}$/);
    expect(second).not.toBe(first);
  });

  it("passes the client IP to the captcha verifier as corroborating evidence", async () => {
    const captcha = new FakeCaptcha(true);
    await serviceWith(captcha).submit(SUBMISSION, "203.0.113.4");

    expect(captcha.seen).toEqual([{ token: "token-abc", ip: "203.0.113.4" }]);
  });

  it("drops a bot submission silently — no rows, no distinguishable response", async () => {
    const service = serviceWith(new FakeCaptcha(false));

    await expect(service.submit(SUBMISSION, null)).resolves.toEqual({ sent: true });
    expect(prisma.batches).toHaveLength(0);
  });

  it("logs the drop so a misconfigured site key is diagnosable, without the message body", async () => {
    await serviceWith(new FakeCaptcha(false)).submit(SUBMISSION, null);

    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain("AK-CRE-300");
  });

  it("VERIFIES even when the client sent no token, so omitting it is not a bypass", async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the behaviour it pinned was a
    // hole. `contactRequestSchema` models the token as `.nullable().default(null)`
    // — unlike the auth schemas, which demand `.min(1)` — so skipping the check
    // whenever it was null meant any caller could evade the captcha completely by
    // simply not sending the field. No amount of configuring TURNSTILE_SECRET_KEY
    // could close that; the endpoint mails an autoreply to a caller-chosen
    // address, so it is the one that matters most.
    //
    // Nothing changes where no secret is configured: the container binds
    // `AlwaysAllowCaptchaVerifier`, which accepts the empty token, so a dev
    // machine and the current deployment behave exactly as before.
    const captcha = new FakeCaptcha(false);
    const noToken = contactRequestSchema.parse({
      name: "Marta",
      email: "marta@example.com",
      message: "Hello",
    });

    await serviceWith(captcha).submit(noToken, null);

    expect(captcha.seen).toHaveLength(1);
    expect(captcha.seen[0]?.token).toBe("");
    // Dropped, and reported as `{ sent: true }` — an automated submitter learns
    // nothing from the response, exactly as for a rejected token.
    expect(prisma.batches).toHaveLength(0);
  });
});

describe("deriveSubject", () => {
  it("uses the first line, which is a better queue handle than a constant", () => {
    expect(deriveSubject("Sizing question\nDetails follow.")).toBe(
      "Sizing question",
    );
  });

  it("falls back to the whole message when the first line is blank", () => {
    expect(deriveSubject("\n\n  Actual question here")).toBe("Actual question here");
  });

  it("truncates inside the template's own bound so a long line stays renderable", () => {
    const subject = deriveSubject("x".repeat(500));

    expect(subject).toHaveLength(120);
    expect(subject.endsWith("...")).toBe(true);
  });

  it("never returns an empty string, which no template accepts", () => {
    expect(deriveSubject("   ")).toBe("Contact form");
  });
});
