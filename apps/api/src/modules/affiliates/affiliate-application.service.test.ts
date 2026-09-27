import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { affiliateApplicationSchema } from "@akai/contracts";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import type { PrismaService } from "../prisma/prisma.service";
import type { CaptchaVerifier } from "../auth/ports/captcha.port";
import type { Clock } from "../auth/ports/clock.port";
import { AffiliateApplicationService } from "./affiliate-application.service";

const OPS_INBOX = "ops@akai.test";

/**
 * Same "record the transaction's arguments" fake `contact.service.test.ts`
 * uses — asserting the writes arrive as ONE array is asserting the atomicity
 * guarantee (affiliate row + both emails commit together or none do).
 */
interface RecordedOutboxRow {
  readonly kind: "outbox";
  readonly topic: string;
  readonly payload: unknown;
}
interface RecordedAffiliateRow {
  readonly kind: "affiliate";
  readonly data: unknown;
}
type RecordedWrite = RecordedOutboxRow | RecordedAffiliateRow;

class FakePrisma {
  readonly batches: RecordedWrite[][] = [];

  readonly affiliate = {
    create: (args: { data: unknown }): RecordedAffiliateRow => ({
      kind: "affiliate",
      data: args.data,
    }),
  };

  readonly outboxMessage = {
    create: (args: { data: { topic: string; payload: unknown } }): RecordedOutboxRow => ({
      kind: "outbox",
      topic: args.data.topic,
      payload: args.data.payload,
    }),
  };

  $transaction(rows: RecordedWrite[]): Promise<RecordedWrite[]> {
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

const envelopeSchema = z.object({
  templateKey: z.string(),
  to: z.string(),
  locale: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

function outboxEnvelopesOf(prisma: FakePrisma): z.infer<typeof envelopeSchema>[] {
  const [batch = []] = prisma.batches;
  return batch
    .filter((row): row is RecordedOutboxRow => row.kind === "outbox")
    .map((row) => envelopeSchema.parse(row.payload));
}

function affiliateWriteOf(prisma: FakePrisma): unknown {
  const [batch = []] = prisma.batches;
  return batch.find((row): row is RecordedAffiliateRow => row.kind === "affiliate")?.data;
}

const APPLICATION = affiliateApplicationSchema.parse({
  name: "Marta",
  country: "ES",
  socialHandle: "@marta.recovers",
  email: "marta@example.com",
  locale: "en",
  turnstileToken: "token-abc",
});

describe("AffiliateApplicationService.submit", () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = new FakePrisma();
    warnings.length = 0;
  });

  function serviceWith(captcha: CaptchaVerifier): AffiliateApplicationService {
    return new AffiliateApplicationService(
      prisma as unknown as PrismaService,
      captcha,
      clock,
      config,
      logger,
    );
  }

  it("accepts an application and reports it as received", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await expect(service.submit(APPLICATION, "203.0.113.4")).resolves.toEqual({
      received: true,
    });
  });

  it("writes the affiliate row AND both mails in ONE transaction", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(APPLICATION, null);

    expect(prisma.batches).toHaveLength(1);
    expect(prisma.batches[0]).toHaveLength(3);
    expect(affiliateWriteOf(prisma)).toMatchObject({
      name: "Marta",
      country: "ES",
      socialHandle: "@marta.recovers",
      email: "marta@example.com",
    });
    expect(outboxEnvelopesOf(prisma)).toHaveLength(2);
  });

  it("sends the staff copy to the operations inbox, never to the applicant", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(APPLICATION, null);
    const [staff] = outboxEnvelopesOf(prisma);

    expect(staff?.templateKey).toBe("affiliate-application-received");
    expect(staff?.to).toBe(OPS_INBOX);
    expect(staff?.payload["replyTo"]).toBe("marta@example.com");
    expect(staff?.payload["country"]).toBe("ES");
    expect(staff?.payload["socialHandle"]).toBe("@marta.recovers");
  });

  it("prefers CONTACT_INBOX_EMAIL over EMAIL_FROM when both are set", async () => {
    const supportInbox = "support@akai.test";
    const service = new AffiliateApplicationService(
      prisma as unknown as PrismaService,
      new FakeCaptcha(true),
      clock,
      { EMAIL_FROM: OPS_INBOX, CONTACT_INBOX_EMAIL: supportInbox } as unknown as ServerEnv,
      logger,
    );

    await service.submit(APPLICATION, null);
    const [staff] = outboxEnvelopesOf(prisma);

    expect(staff?.to).toBe(supportInbox);
  });

  it("acknowledges the applicant with the same reference id the team sees", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(APPLICATION, null);
    const [staff, autoreply] = outboxEnvelopesOf(prisma);

    expect(autoreply?.templateKey).toBe("affiliate-application-autoreply");
    expect(autoreply?.to).toBe("marta@example.com");
    expect(autoreply?.payload["referenceId"]).toBe(staff?.payload["referenceId"]);
  });

  it("renders in the applicant's locale", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(APPLICATION, null);

    expect(outboxEnvelopesOf(prisma).map((envelope) => envelope.locale)).toEqual(["en", "en"]);
  });

  it("mints an unguessable, non-sequential reference", async () => {
    const service = serviceWith(new FakeCaptcha(true));

    await service.submit(APPLICATION, null);
    const first = outboxEnvelopesOf(prisma)[0]?.payload["referenceId"];

    prisma.batches.length = 0;
    await service.submit(APPLICATION, null);
    const second = outboxEnvelopesOf(prisma)[0]?.payload["referenceId"];

    expect(first).toMatch(/^AF-[0-9A-F]{10}$/);
    expect(second).not.toBe(first);
  });

  it("passes the client IP to the captcha verifier as corroborating evidence", async () => {
    const captcha = new FakeCaptcha(true);
    await serviceWith(captcha).submit(APPLICATION, "203.0.113.4");

    expect(captcha.seen).toEqual([{ token: "token-abc", ip: "203.0.113.4" }]);
  });

  it("drops a bot application silently — no rows, no distinguishable response", async () => {
    const service = serviceWith(new FakeCaptcha(false));

    await expect(service.submit(APPLICATION, null)).resolves.toEqual({ received: true });
    expect(prisma.batches).toHaveLength(0);
  });

  it("logs the drop so a misconfigured site key is diagnosable", async () => {
    await serviceWith(new FakeCaptcha(false)).submit(APPLICATION, null);

    expect(warnings).toHaveLength(1);
  });

  it("VERIFIES even when the client sent no token, so omitting it is not a bypass", async () => {
    // Same reasoning `contact.service.test.ts` records for the identical
    // line: `affiliateApplicationSchema` models the token as
    // `.nullable().default(null)`, so guarding only on `!== null` would let
    // a caller skip the captcha entirely.
    const captcha = new FakeCaptcha(false);
    const noToken = affiliateApplicationSchema.parse({
      name: "Marta",
      country: "ES",
      socialHandle: "@marta.recovers",
      email: "marta@example.com",
    });

    await serviceWith(captcha).submit(noToken, null);

    expect(captcha.seen).toHaveLength(1);
    expect(captcha.seen[0]?.token).toBe("");
    expect(prisma.batches).toHaveLength(0);
  });
});
