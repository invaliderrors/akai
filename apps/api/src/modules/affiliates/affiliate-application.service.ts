import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type {
  AffiliateApplication,
  AffiliateApplicationResponse,
} from "@akai/contracts";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import { CAPTCHA_VERIFIER, type CaptchaVerifier } from "../auth/ports/captcha.port";
import { CLOCK, type Clock } from "../auth/ports/clock.port";

/**
 * Affiliate applications.
 *
 * SAME SHAPE AS `ContactService`, deliberately — a second anonymous public
 * write that must be both captcha-gated and rate limited (see
 * `AffiliateApplicationModule` for how both are bound), and whose acceptance
 * must survive a transport outage, which is why it writes OUTBOX rows rather
 * than calling the mail transport inline.
 *
 * WHAT THIS DOES THAT `ContactService` DOES NOT: it also creates the
 * `Affiliate` row itself, durably, in the SAME transaction as the two email
 * rows. An application is not staged anywhere else waiting for a separate
 * "approve" step — the admin affiliates screen (§14) IS the review queue.
 * Staff either assign the new row a coupon (their form of approval) or
 * delete it (rejection); there is no third state to model.
 */
@Injectable()
export class AffiliateApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Accept an application.
   *
   * FAILS CLOSED ON A CAPTCHA VERDICT, silently — identical policy and
   * identical reasoning to `ContactService.submit`: an automated submitter
   * gets no signal to tune its attack, and the drop is logged so a
   * misconfigured site key is diagnosable from logs rather than only from
   * "nobody is applying" going unnoticed.
   */
  async submit(
    request: AffiliateApplication,
    clientIp: string | null,
  ): Promise<AffiliateApplicationResponse> {
    const referenceId = this.mintReference();

    // ALWAYS VERIFIED, EVEN WHEN THE TOKEN IS ABSENT — same reasoning
    // `ContactService.submit` documents for its own identical line: the
    // field is `.nullable().default(null)`, so guarding on `!== null` alone
    // would let a caller skip the captcha entirely by omitting it.
    const verified = await this.captcha.verify(request.turnstileToken ?? "", clientIp);
    if (!verified) {
      this.logger.warn(
        { referenceId },
        "Affiliate application dropped: captcha verification failed",
      );
      return { received: true };
    }

    const submittedAt = this.clock.now().toISOString();

    // ONE transaction, three writes: the affiliate row itself, plus the same
    // "staff notification + applicant acknowledgement" pair the contact form
    // uses. All three commit together or none do — a state where the
    // applicant is recorded but nobody was told, or the reverse, is exactly
    // the failure mode a single transaction rules out.
    await this.prisma.$transaction([
      this.prisma.affiliate.create({
        data: {
          name: request.name,
          country: request.country,
          socialHandle: request.socialHandle,
          email: request.email,
        },
      }),
      this.prisma.outboxMessage.create({
        data: {
          topic: "email",
          payload: {
            templateKey: "affiliate-application-received",
            to: this.config.CONTACT_INBOX_EMAIL ?? this.config.EMAIL_FROM,
            locale: request.locale,
            payload: {
              referenceId,
              name: request.name,
              replyTo: request.email,
              country: request.country,
              socialHandle: request.socialHandle,
              submittedAt,
            },
          },
        },
      }),
      this.prisma.outboxMessage.create({
        data: {
          topic: "email",
          payload: {
            templateKey: "affiliate-application-autoreply",
            to: request.email,
            locale: request.locale,
            payload: { name: request.name, referenceId },
          },
        },
      }),
    ]);

    // Same discipline `ContactService.submit` follows: only the reference id
    // is logged. The application itself is personal data supplied by a
    // member of the public and lives in exactly one place — the row this
    // call just created.
    this.logger.info({ referenceId }, "Affiliate application accepted");

    return { received: true };
  }

  /**
   * A short, quotable reference — same construction as `ContactService`'s
   * own `mintReference`, random rather than sequential for the identical
   * reason: a sequential id would leak application volume.
   */
  private mintReference(): string {
    return `AF-${randomBytes(5).toString("hex").toUpperCase()}`;
  }
}
