
/**
 * Domain events the auth module emits for the email module to consume.
 *
 * This module NEVER sends email. It states that something happened; the email
 * module owns templates, localisation, the send log and the idempotency key.
 * That split is what lets a password reset be tested without a mail transport
 * and lets email delivery be retried without re-running the reset logic.
 *
 * Delivery is via the transactional OUTBOX (spec §9): the implementation is
 * expected to write the event row inside the SAME transaction as the state
 * change that produced it, so a rolled-back registration cannot leave a
 * "verify your email" job queued for a customer that does not exist. The
 * in-process default binding is a no-op collector; the integration agent binds
 * the real outbox writer (see followUps).
 */

/**
 * Events that carry a RAW single-use token.
 *
 * The token is in the event because the email needs to build the link, and the
 * database only ever holds its SHA-256. This is the one place raw token
 * material crosses a module boundary — which is why `token` must never be
 * logged, and why the outbox row holding it should be pruned once dispatched.
 */
/**
 * WHICH FRONT-END THE ACTION CAME FROM.
 *
 * The only consumer is the link a token-bearing email carries. Auth used to
 * live exclusively in the dashboard, so `OutboxAuthEventPublisher` hard-coded
 * `DASHBOARD_URL` — which meant a customer who registered on the STOREFRONT was
 * mailed an `app.akai.shop` link and bounced out of the shop they were in.
 *
 * It is OPTIONAL, and the publisher defaults an absent value to the dashboard,
 * so every existing emitter keeps its current behaviour without being touched.
 * A closed union rather than a URL: an origin supplied by a request is
 * attacker-controlled, and a raw base URL on this event would be an open-redirect
 * planted in an email we send. Two names that the server resolves against its
 * own config cannot be one.
 *
 * NOTE FOR WHOEVER WIRES THE STOREFRONT END. The verification token is
 * SINGLE-USE. Once both apps host `/verify-email`, a mail-client prefetch or a
 * customer opening the link twice redeems it once and shows "link expired" the
 * second time — which is why the page POSTs the token rather than redeeming it
 * on GET, and why only ONE app should be named as the origin per event.
 */
export type AuthEventOrigin = "storefront" | "dashboard";

export interface AuthEventBase {
  readonly customerId: string;
  readonly email: string;
  readonly occurredAt: Date;
  /** Absent means the dashboard — see `AuthEventOrigin`. */
  readonly origin?: AuthEventOrigin;
}

export type AuthDomainEvent =
  | (AuthEventBase & {
      readonly type: "auth.customer.registered";
      /** Raw email-verification token. Never log this field. */
      readonly verificationToken: string;
      readonly expiresAt: Date;
    })
  | (AuthEventBase & {
      readonly type: "auth.email_verification.requested";
      /** Raw email-verification token. Never log this field. */
      readonly verificationToken: string;
      readonly expiresAt: Date;
    })
  | (AuthEventBase & { readonly type: "auth.email_verification.completed" })
  /**
   * Emitted when registration is attempted against an address that ALREADY has
   * an account. The endpoint returns the same neutral response as a genuine
   * signup, so this event is what closes the loop honestly: the real owner is
   * told someone tried, instead of the attacker being told the account exists.
   */
  | (AuthEventBase & { readonly type: "auth.registration.duplicate_attempt" })
  | (AuthEventBase & {
      readonly type: "auth.password_reset.requested";
      /** Raw password-reset token. Never log this field. */
      readonly resetToken: string;
      readonly expiresAt: Date;
    })
  | (AuthEventBase & { readonly type: "auth.password_reset.completed" })
  | (AuthEventBase & { readonly type: "auth.password.changed" })
  /** A refresh-token replay. Security-relevant: the whole family was revoked. */
  | (AuthEventBase & {
      readonly type: "auth.refresh_token.reuse_detected";
      readonly familyId: string;
    })
  | (AuthEventBase & { readonly type: "auth.account.locked"; readonly lockedUntil: Date })
  | (AuthEventBase & {
      readonly type: "auth.login_code.requested";
      /**
       * The code itself, in clear, because the mail IS the delivery channel —
       * only its digest is stored, so there is nothing to re-read later. It is
       * never logged. The outbox row holding it is a live credential until the
       * retention sweep prunes it (see followUps), which is the same exposure
       * the verification and reset tokens already carry.
       */
      readonly code: string;
      readonly expiresAt: Date;
    })
  | (AuthEventBase & { readonly type: "auth.two_factor.enabled" })
  | (AuthEventBase & { readonly type: "auth.two_factor.disabled" });

export type AuthEventType = AuthDomainEvent["type"];

export interface AuthEventPublisher {
  publish(event: AuthDomainEvent): Promise<void>;
}

export const AUTH_EVENT_PUBLISHER = Symbol("AUTH_EVENT_PUBLISHER");

/**
 * Default binding: collects in memory and does nothing else.
 *
 * Chosen over "throw not implemented" deliberately — auth must keep working
 * while the outbox module is still a placeholder, and a registration that
 * 500s because email is unwired is a worse failure than a verification mail
 * that is not yet sent. The collector is also what the service tests assert on.
 */
export class InMemoryAuthEventPublisher implements AuthEventPublisher {
  private readonly collected: AuthDomainEvent[] = [];

  publish(event: AuthDomainEvent): Promise<void> {
    this.collected.push(event);
    return Promise.resolve();
  }

  /** Test helper. Returns a copy so callers cannot mutate the log. */
  events(): readonly AuthDomainEvent[] {
    return [...this.collected];
  }

  eventsOfType<T extends AuthEventType>(
    type: T,
  ): readonly Extract<AuthDomainEvent, { type: T }>[] {
    return this.collected.filter(
      (event): event is Extract<AuthDomainEvent, { type: T }> => event.type === type,
    );
  }

  clear(): void {
    this.collected.length = 0;
  }
}
