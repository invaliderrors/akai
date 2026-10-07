import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { ContactRequest, ContactResponse } from "@akai/contracts";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import { CAPTCHA_VERIFIER, type CaptchaVerifier } from "../auth/ports/captcha.port";
import { CLOCK, type Clock } from "../auth/ports/clock.port";

/**
 * Contact-form submissions.
 *
 * The public contact form's only destination. A public, unauthenticated endpoint
 * that sends mail is an open relay unless it is both captcha-gated and rate
 * limited — see `ContactModule` for how both are bound.
 *
 * THE DURABILITY DECISION: a submission is accepted by writing an `email` OUTBOX
 * ROW, not by calling the mail transport inline. The old endpoint did the
 * opposite, so a Resend hiccup meant the message was simply gone — the submitter
 * saw a 502, retyped it, and got another 502. An outbox row is committed to
 * Postgres and retried with backoff by the dispatcher, so acceptance survives a
 * transport outage. It also keeps the request fast: an anonymous POST must not
 * block on a third-party API.
 *
 * TWO ROWS PER SUBMISSION, deliberately independent:
 *   1. `contact-received` to the operations inbox — the message itself.
 *   2. `contact-autoreply` to the submitter — an acknowledgement with the same
 *      reference id.
 * Separate rows so a suppressed or bouncing SUBMITTER address cannot stop the
 * team from receiving the message. One row carrying both would fail as a unit,
 * and the failure mode would be losing customer messages from exactly the people
 * whose mail setup is already broken.
 */
@Injectable()
export class ContactService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Accept a submission.
   *
   * FAILS CLOSED ON A CAPTCHA VERDICT, silently. A verified-false token means
   * the request is almost certainly a bot, and the response is an ordinary
   * `{ sent: true }` rather than an error: telling an automated submitter that
   * its token was rejected is free feedback for tuning the attack, and no human
   * ever sees the difference. The drop IS logged, so a misconfigured site key
   * showing up as "nobody can contact us" is diagnosable from the logs rather
   * than only from a complaint.
   *
   * This is not the same as the verifier's own fail-OPEN policy on a transport
   * error: an explicit "no" is honoured, an unreachable Cloudflare is not
   * allowed to take the contact form down with it.
   */
  async submit(request: ContactRequest, clientIp: string | null): Promise<ContactResponse> {
    const referenceId = this.mintReference();

    // ALWAYS VERIFIED, EVEN WHEN THE TOKEN IS ABSENT. `turnstileToken` is
    // `.nullable().default(null)` on this endpoint (unlike the auth ones, which
    // are `.min(1)`), so guarding on `!== null` meant a caller could skip the
    // captcha entirely by simply omitting the field — the one bypass no amount
    // of secret-key configuration could close.
    //
    // Passing "" through instead of branching keeps the unconfigured case
    // behaving exactly as before: with no secret the container binds
    // `AlwaysAllowCaptchaVerifier`, which accepts anything, so a dev machine
    // and today's deployment are unaffected. Once a secret IS configured, an
    // absent token is what it always was — not a human.
    const verified = await this.captcha.verify(request.turnstileToken ?? "", clientIp);
    if (!verified) {
      this.logger.warn(
        { referenceId },
        "Contact submission dropped: captcha verification failed",
      );
      return { sent: true };
    }

    const submittedAt = this.clock.now().toISOString();
    const subject = deriveSubject(request.message);

    // ONE transaction, two rows. Either both side-effects are committed or
    // neither is, so there is no state in which the team is notified but the
    // submitter never hears back — or the reverse.
    await this.prisma.$transaction([
      this.prisma.outboxMessage.create({
        data: {
          topic: "email",
          payload: {
            templateKey: "contact-received",
            // The OPERATIONS inbox, never the submitter. The submitter's address
            // travels in `replyTo` inside the payload, where it is rendered as
            // data rather than used as a destination. `CONTACT_INBOX_EMAIL` is
            // deliberately separate from `EMAIL_FROM` — see that field's doc
            // comment in `libs/config` for why sharing one value is a
            // deliverability risk, not just a naming inconvenience.
            to: this.config.CONTACT_INBOX_EMAIL ?? this.config.EMAIL_FROM,
            payload: {
              referenceId,
              name: request.name,
              replyTo: request.email,
              subject,
              message: request.message,
              submittedAt,
            },
          },
        },
      }),
      this.prisma.outboxMessage.create({
        data: {
          topic: "email",
          payload: {
            templateKey: "contact-autoreply",
            to: request.email,
            payload: { name: request.name, subject, referenceId },
          },
        },
      }),
    ]);

    // The message body is NOT logged. It is unstructured personal data supplied
    // by a member of the public, and a log line is the one place it would be
    // retained outside any deletion policy. The reference id is enough to
    // correlate the submission with the mails it produced.
    this.logger.info({ referenceId }, "Contact submission accepted");

    return { sent: true };
  }

  /**
   * A short, quotable reference.
   *
   * Random rather than sequential: a sequential id published in an
   * acknowledgement email tells anyone who receives one how many messages the
   * store gets, and lets them enumerate other people's references. 5 random
   * bytes is 40 bits — collision-safe at this volume, short enough to read out
   * over the phone.
   */
  private mintReference(): string {
    return `CT-${randomBytes(5).toString("hex").toUpperCase()}`;
  }
}

/**
 * A subject line derived from the message.
 *
 * The form has no subject field (adding one is a UX decision this module does
 * not get to make), but both templates need something to show. The first line,
 * truncated, is a better handle for a support queue than a constant string like
 * "Contact form submission" repeated across every row.
 *
 * Exported for test, and pure. The 120-character cap sits well inside the
 * templates' 300-character bound, so a long first line can never make a
 * submission that passed validation unrenderable.
 */
export function deriveSubject(message: string): string {
  const [firstLine = ""] = message.split("\n");
  const trimmed = firstLine.trim();
  const source = trimmed.length > 0 ? trimmed : message.trim();

  if (source.length === 0) {
    return "Contact form";
  }
  return source.length <= 120 ? source : `${source.slice(0, 117)}...`;
}
