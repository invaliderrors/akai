import { Inject, Injectable } from "@nestjs/common";

import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../../config/config.module";
import { LOGGER } from "../../observability/logger.module";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthDomainEvent, AuthEventOrigin, AuthEventPublisher } from "./auth-events.port";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The timing window an emitted event describes, plus which app should host the
 * link built from it. `origin` is optional and defaults to the dashboard — see
 * `authBase`.
 */
interface EventWindow {
  readonly occurredAt: Date;
  readonly expiresAt: Date;
  readonly origin?: AuthEventOrigin | undefined;
}

/** Clamp a positive integer into an inclusive range, so a schema bound cannot be violated. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Drop a trailing slash so the concatenated path never doubles it. */
function baseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * REAL binding for the auth event publisher (replaces `InMemoryAuthEventPublisher`).
 *
 * The `InMemory` default pushed every event — INCLUDING the raw verification and
 * reset tokens — into an array and dropped it, so no verification or reset mail
 * was ever deliverable. Verification is required before a first order, so that
 * left the whole customer flow a dead end.
 *
 * This writer turns the two token-bearing events into `email` outbox rows. It
 * emits the FULLY-HYDRATED shape (`{ templateKey, to, payload }`) rather
 * than an order reference: the reset/verify link can only be built here, at emit
 * time, from the one-time token that never touches the database in clear text.
 * `EmailOutboxHandler` sends it; `EmailService` owns delivery, suppression
 * exemption (spec §10) and the log.
 *
 * DURABILITY NOTE: `AuthService` calls `publish` AFTER the state-change
 * transaction commits (its wrapper swallows any error so a mail hiccup can never
 * fail a registration). This writer matches that contract — a single insert into
 * `outbox_message`. A crash in the millisecond between commit and this insert
 * loses the mail; the resend path (`POST /auth/verify-email/resend`) is the
 * recovery, and moving the enqueue INTO the state transaction would require
 * threading a tx handle through the port, which is a larger auth-internal change
 * owned elsewhere.
 *
 * The raw token is written into the outbox payload because the link needs it. It
 * is NEVER logged here, and a processed row that still holds it is pruned by the
 * retention sweep (spec §5) — see followUps.
 */
@Injectable()
export class OutboxAuthEventPublisher implements AuthEventPublisher {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async publish(event: AuthDomainEvent): Promise<void> {
    switch (event.type) {
      case "auth.customer.registered":
      case "auth.email_verification.requested":
        await this.enqueueVerifyEmail(event.email, event.verificationToken, {
          occurredAt: event.occurredAt,
          expiresAt: event.expiresAt,
          origin: event.origin,
        });
        return;

      case "auth.login_code.requested":
        await this.enqueueLoginCode(event.email, event.code, {
          occurredAt: event.occurredAt,
          expiresAt: event.expiresAt,
          origin: event.origin,
        });
        return;

      case "auth.password_reset.requested":
        await this.enqueueResetPassword(event.email, event.resetToken, {
          occurredAt: event.occurredAt,
          expiresAt: event.expiresAt,
          origin: event.origin,
        });
        return;

      // The remaining events are security-relevant but have no customer-facing
      // template today (completed/changed confirmations, 2FA toggles, lockouts,
      // refresh-reuse). They are audited elsewhere; nothing to enqueue here.
      default:
        this.logger.debug(
          { eventType: event.type, customerId: event.customerId },
          "Auth event has no email template; not enqueued",
        );
        return;
    }
  }

  private async enqueueVerifyEmail(
    email: string,
    token: string,
    window: EventWindow,
  ): Promise<void> {
    const expiresInHours = clamp(
      (window.expiresAt.getTime() - window.occurredAt.getTime()) / HOUR_MS,
      1,
      168,
    );
    await this.enqueue("verify-email", email, {
      firstName: this.greetingName(email),
      verifyUrl: `${this.authBase(window.origin)}/verify-email?token=${encodeURIComponent(token)}`,
      expiresInHours,
    });
  }

  private async enqueueResetPassword(
    email: string,
    token: string,
    window: EventWindow,
  ): Promise<void> {
    const expiresInMinutes = clamp(
      (window.expiresAt.getTime() - window.occurredAt.getTime()) / MINUTE_MS,
      1,
      1440,
    );
    await this.enqueue("reset-password", email, {
      firstName: this.greetingName(email),
      resetUrl: `${this.authBase(window.origin)}/reset-password?token=${encodeURIComponent(token)}`,
      expiresInMinutes,
    });
  }

  /**
   * The mailed sign-in code.
   *
   * NO URL, and that is the whole point. `enqueueVerifyEmail` and
   * `enqueueResetPassword` both build a link because a link is what they
   * deliver; a one-click link in a SIGN-IN mail is a bearer credential that
   * survives forwarding, and it is the most phishable thing a shop can send.
   * The code is typed back into the tab that asked for it, so possession of the
   * mail alone is not a session.
   */
  private async enqueueLoginCode(
    email: string,
    code: string,
    window: EventWindow,
  ): Promise<void> {
    const expiresInMinutes = clamp(
      (window.expiresAt.getTime() - window.occurredAt.getTime()) / MINUTE_MS,
      1,
      60,
    );
    await this.enqueue("login-code", email, {
      firstName: this.greetingName(email),
      code,
      expiresInMinutes,
    });
  }

  private async enqueue(
    templateKey: "verify-email" | "reset-password" | "login-code",
    to: string,
    payload: Record<string, string | number>,
  ): Promise<void> {
    await this.prisma.outboxMessage.create({
      data: {
        topic: "email",
        payload: { templateKey, to, payload },
      },
    });
    this.logger.info(
      { templateKey },
      "Auth email enqueued to the outbox",
    );
  }

  /**
   * The app whose `/verify-email` or `/reset-password` page the mailed link
   * opens, at its bare path (neither app has a locale prefix).
   *
   * Spec §8 said "auth lives in the dashboard" and this was hard-coded to
   * DASHBOARD_URL. It no longer does: the storefront hosts sign-up and
   * verification too, and mailing a shopper an `app.` link sent them out of the
   * shop to confirm an address. The event now names its origin.
   *
   * ABSENT ORIGIN MEANS DASHBOARD, deliberately: every emitter in `AuthService`
   * omits it today, so the default is what keeps this change behaviour-preserving
   * for all of them. The origin is a closed union resolved against OUR OWN config
   * here — never a URL carried on the event, which would be an attacker-supplied
   * open redirect planted inside an email we sign our name to.
   */
  private authBase(origin: AuthEventOrigin | undefined): string {
    return baseUrl(
      origin === "storefront" ? this.config.STOREFRONT_URL : this.config.DASHBOARD_URL,
    );
  }

  /**
   * A greeting name without leaking anything the event did not carry.
   *
   * The auth events intentionally do not include the customer's name, so it is
   * derived from the email's local part — always present, always non-empty for a
   * valid address, and bounded to the template's 120-char limit. The renderer
   * escapes it, so an address-shaped injection is inert.
   */
  private greetingName(email: string): string {
    const localPart = email.split("@")[0] ?? "";
    const trimmed = localPart.trim();
    if (trimmed.length === 0) {
      return "Cliente";
    }
    return trimmed.slice(0, 120);
  }
}
