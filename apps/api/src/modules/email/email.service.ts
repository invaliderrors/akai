import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ZodError, z } from "zod";
import {
  emailSchema,
  emailTemplateKeySchema,
  type EmailTemplateKey,
  type SendEmailInput,
  type SendEmailResult,
} from "@akai/contracts";
import type { Logger } from "@akai/observability";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import {
  DEFAULT_EMAIL_RETRY_POLICY,
  EMAIL_RETRY_POLICY,
  EMAIL_SLEEPER,
  EMAIL_TRANSPORT,
  EmailDeliveryError,
  buildTags,
  type EmailRetryPolicy,
  type EmailTransport,
  type Sleeper,
} from "./email.port";
import { renderEmail } from "./email.renderer";
import {
  INTERNAL_TEMPLATE_KEYS,
  PER_PARCEL_TEMPLATE_KEYS,
  SUPPRESSION_EXEMPT_TEMPLATE_KEYS,
  parseTemplatePayload,
  type EmailPayloadFor,
} from "./email.templates";

/**
 * `email_event.dedupeScope` is VARCHAR(64) NOT NULL. Parsed rather than trusted:
 * an over-long scope would be a driver error thrown from inside the claim, and
 * `send()` promises never to throw.
 */
const dedupeScopeSchema = z.string().max(64);

/** "The whole order" — the scope every once-per-order template keeps. */
const ORDER_SCOPE = "";

/** `email_event.error` is VarChar(1000); truncate before the driver rejects the row. */
const MAX_ERROR_LENGTH = 1000;

export interface SendEmailRequest<K extends EmailTemplateKey> {
  readonly templateKey: K;
  readonly to: string;
  readonly payload: EmailPayloadFor<K>;
  /**
   * Present for every order-related mail. Its presence is what activates the
   * `(orderId, templateKey, dedupeScope)` uniqueness — see `send()`.
   */
  readonly orderId?: string;
  /**
   * Widens the idempotency key WITHIN an order. Defaults to "" — the whole
   * order — which is what every template that fires once per order wants.
   * `shipping-confirmation` fires once per PARCEL and must pass the shipment
   * id; sending it unscoped is refused rather than silently deduped.
   */
  readonly dedupeScope?: string;
}

/**
 * The outcome of a dispatch. A UNION rather than a boolean because the five
 * outcomes need genuinely different operator responses: `duplicate` is the
 * system working correctly, `suppressed` is a reputation guard, `rejected` is
 * our bug, and only `failed` warrants a page.
 */
export type EmailDispatchResult =
  | {
      readonly status: "sent";
      readonly eventId: string;
      readonly providerMessageId: string;
      readonly attempts: number;
    }
  | { readonly status: "duplicate"; readonly templateKey: EmailTemplateKey }
  | { readonly status: "suppressed"; readonly reason: string }
  | {
      /**
       * `eventId` is nullable because delivery can fail BEFORE the event row
       * exists — if the claiming insert itself fails, there is nothing to point
       * at. Modelling that as `string` would have forced either a fabricated id
       * or a rethrow, and a rethrow is precisely what property 1 forbids.
       */
      readonly status: "failed";
      readonly eventId: string | null;
      readonly error: string;
      readonly attempts: number;
    }
  | { readonly status: "rejected"; readonly error: string };

/**
 * Prisma's known-request errors carry a stable `code`. Narrowed STRUCTURALLY
 * rather than with `instanceof Prisma.PrismaClientKnownRequestError` so this
 * check has no dependency on Prisma's runtime error class — which in turn means
 * a unit test can simulate a unique-constraint race with a plain object instead
 * of constructing a Prisma internal. The behaviour under test is "the DB said
 * P2002", and that is exactly what this asserts.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

function describeError(error: unknown): string {
  if (error instanceof EmailDeliveryError) {
    return error.message.slice(0, MAX_ERROR_LENGTH);
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, MAX_ERROR_LENGTH);
  }
  return "Unknown transport error";
}

/**
 * TRANSACTIONAL EMAIL.
 *
 * Three properties this service is built to guarantee, in priority order:
 *
 * 1. IT NEVER THROWS. `send()` returns a result union. A Resend outage must not
 *    turn a successful payment into a 500 — the money moved, the order exists,
 *    and failing the request would leave the customer retrying a charge that
 *    already succeeded. Email is strictly less important than the transaction
 *    that triggered it, and the control flow says so.
 *
 * 2. IT NEVER DOUBLE-SENDS AN ORDER MAIL. Idempotency is a DB unique constraint
 *    on `(orderId, templateKey)`, claimed BEFORE the provider call. Wompi
 *    retries webhooks aggressively; a check-then-send would race and mail three
 *    confirmations for one order.
 *
 * 3. EVERY ATTEMPT IS LOGGED. An `email_event` row exists before the first
 *    provider call, so a crash mid-send leaves evidence rather than silence.
 */
@Injectable()
export class EmailService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(EMAIL_SLEEPER) private readonly sleep: Sleeper,
    @Inject(EMAIL_RETRY_POLICY) private readonly retryPolicy: EmailRetryPolicy,
  ) {}

  /**
   * Send one templated email. Generic over the template key, so the payload is
   * checked at COMPILE time; `parseTemplatePayload` re-checks at runtime for
   * callers arriving through the untyped `EmailPort` boundary.
   */
  async send<K extends EmailTemplateKey>(
    request: SendEmailRequest<K>,
  ): Promise<EmailDispatchResult> {
    const orderId = request.orderId ?? null;

    // --- 1. Validate our own inputs ----------------------------------------
    let recipient: string;
    let payload: EmailPayloadFor<K>;
    let dedupeScope: string;
    try {
      recipient = emailSchema.parse(request.to);
      payload = parseTemplatePayload(request.templateKey, request.payload);
      dedupeScope = dedupeScopeSchema.parse(request.dedupeScope ?? ORDER_SCOPE);
    } catch (error) {
      const description =
        error instanceof ZodError
          ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
          : describeError(error);

      // Our bug, not the caller's: log at error so it is alertable, but still
      // return rather than throw — property 1 holds even for programmer error.
      this.logger.error(
        { templateKey: request.templateKey, orderId, reason: description },
        "Refusing to send an email with an invalid payload",
      );
      return { status: "rejected", error: description.slice(0, MAX_ERROR_LENGTH) };
    }

    // --- 1b. A per-parcel template MUST carry a scope ------------------------
    //
    // Unscoped, its claim lands on the same (orderId, templateKey, '') row as
    // the first parcel's, `claim` reports `duplicate`, and the outbox handler
    // treats `duplicate` as a terminal SUCCESS — so parcel two is never mailed
    // and nothing anywhere records that it wasn't. Refusing turns that silent
    // data loss into a dead-letter an operator can see.
    if (
      orderId !== null &&
      dedupeScope === ORDER_SCOPE &&
      PER_PARCEL_TEMPLATE_KEYS.has(request.templateKey)
    ) {
      const description =
        `Template "${request.templateKey}" fires once per parcel and must carry a ` +
        `dedupeScope (the shipment id). Sending it order-scoped would silently ` +
        `swallow every parcel after the first.`;
      this.logger.error(
        { templateKey: request.templateKey, orderId },
        "Refusing an order-scoped send for a per-parcel template",
      );
      return { status: "rejected", error: description.slice(0, MAX_ERROR_LENGTH) };
    }

    // --- 2. Suppression ----------------------------------------------------
    const suppression = await this.checkSuppression(request.templateKey, recipient);
    if (suppression !== null) {
      this.logger.warn(
        { email: recipient, templateKey: request.templateKey, reason: suppression },
        "Skipping email to a suppressed recipient",
      );
      return { status: "suppressed", reason: suppression };
    }

    // --- 3. Claim idempotency BEFORE calling the provider -------------------
    const claim = await this.claim(
      request.templateKey,
      recipient,
      orderId,
      dedupeScope,
    );

    if (claim.kind === "duplicate") {
      this.logger.info(
        { templateKey: request.templateKey, orderId, dedupeScope },
        "Email already sent for this order, template and scope; skipping duplicate",
      );
      return { status: "duplicate", templateKey: request.templateKey };
    }

    if (claim.kind === "error") {
      // The database is unreachable or rejected the insert. We deliberately do
      // NOT send anyway: without the claim row there is no idempotency guard,
      // and a webhook retry would then mail the customer a second order
      // confirmation. A missing email is recoverable; a duplicate charge
      // notification erodes trust and generates support load.
      this.logger.error(
        { templateKey: request.templateKey, orderId, reason: claim.message },
        "Could not claim an email event row; refusing to send unguarded",
      );
      return { status: "failed", eventId: null, error: claim.message, attempts: 0 };
    }

    // --- 4. Render (pure) ---------------------------------------------------
    const rendered = renderEmail(request.templateKey, payload);

    // --- 5. Deliver, with backoff ------------------------------------------
    return this.deliver(claim, {
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: buildTags(request.templateKey, orderId),
    });
  }

  /**
   * Fire-and-forget. For request handlers that must not wait on a mail server.
   *
   * Returns void deliberately: an awaited `send()` inside a checkout handler
   * adds the provider's latency to the customer's checkout, and its failure
   * handling is already internal. The promise is drained here so an unhandled
   * rejection can never crash the process.
   *
   * NOTE: this is in-process, so a hard crash between the claim and the send
   * loses the mail (the `email_event` row survives as QUEUED, which is how it is
   * detectable). Durable hand-off is the pg-boss `email` queue — see followUps.
   */
  sendInBackground<K extends EmailTemplateKey>(request: SendEmailRequest<K>): void {
    void this.send(request).catch((error: unknown) => {
      // send() is not supposed to reject at all; if it ever does, that is a bug
      // in this service and must be visible rather than swallowed silently.
      this.logger.error(
        { err: error, templateKey: request.templateKey },
        "EmailService.send rejected — this should be impossible",
      );
    });
  }

  /**
   * Bridge for callers holding only the @akai/contracts `EmailPort` shape.
   *
   * That interface types `data` as `Record<string, unknown>` because the port
   * must not know the template vocabulary. This method is where that `unknown`
   * is CLOSED: the payload is parsed against the template's schema before it can
   * reach a renderer.
   *
   * It THROWS, unlike `send()`, because the port's signature promises a
   * `SendEmailResult` — and inventing a message id for a send that did not
   * happen would be a lie to the caller. Consumers that want the non-throwing
   * guarantee use `send()` directly; the port shape is offered for compatibility
   * with `FakeEmailPort`, not as the preferred entry point.
   */
  async sendViaPort(input: SendEmailInput): Promise<SendEmailResult> {
    const result = await this.send({
      templateKey: input.templateKey,
      to: input.to,
      // Parsed inside send(); typed here as the registry payload for that key.
      payload: parseTemplatePayload(input.templateKey, input.data),
      ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
    });

    if (result.status === "sent") {
      return { providerMessageId: result.providerMessageId };
    }
    throw new EmailDeliveryError(
      `Email not delivered (${result.status})`,
      result.status === "failed",
    );
  }

  /**
   * Send from an UNTYPED payload while preserving the full result union.
   *
   * This is the entry point for the outbox `email` consumer. Like `sendViaPort`
   * it accepts `data: unknown` (an outbox row is `Prisma.JsonValue`, so the
   * static type was lost on the round trip) and closes it with a schema parse.
   * Unlike `sendViaPort` it does NOT throw on a non-`sent` outcome: the queue
   * dispatcher needs to tell a terminal success (`duplicate`, `suppressed`)
   * apart from a retryable `failed`, and collapsing them to an exception would
   * make the worker retry — and eventually dead-letter — a mail that was
   * correctly already sent or correctly withheld.
   *
   * A malformed payload becomes `rejected` (our bug), exactly as it would inside
   * `send()`, rather than an unhandled parse throw.
   */
  async sendChecked(input: {
    readonly templateKey: EmailTemplateKey;
    readonly to: string;
    readonly data: unknown;
    readonly orderId?: string;
    readonly dedupeScope?: string;
  }): Promise<EmailDispatchResult> {
    let payload: EmailPayloadFor<EmailTemplateKey>;
    try {
      payload = parseTemplatePayload(input.templateKey, input.data);
    } catch (error) {
      const description =
        error instanceof ZodError
          ? error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")
          : describeError(error);
      this.logger.error(
        { templateKey: input.templateKey, reason: description },
        "Refusing to send an outbox email with an invalid payload",
      );
      return { status: "rejected", error: description.slice(0, MAX_ERROR_LENGTH) };
    }

    return this.send({
      templateKey: input.templateKey,
      to: input.to,
      payload,
      ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
      ...(input.dedupeScope === undefined ? {} : { dedupeScope: input.dedupeScope }),
    });
  }

  /**
   * Re-attempt a previously-failed send, reusing the SAME event row.
   *
   * Two guards that are the point of the method, not decoration:
   *
   * - An event that already reached SENT or DELIVERED is REFUSED (409). The
   *   idempotency constraint only stops a duplicate *insert*; without this
   *   check an operator clicking retry on a delivered order confirmation would
   *   mail the customer a second one, defeating the guarantee from the admin UI
   *   rather than from a webhook.
   * - The template key comes from the STORED ROW, never from the request. The
   *   caller supplies only a payload, so an operator cannot pick an arbitrary
   *   template to render at an address they do not control.
   *
   * Reusing the row (rather than inserting) also preserves the attempt history
   * and keeps the unique constraint intact — a fresh insert would collide.
   */
  async retryFailed(
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<EmailDispatchResult> {
    const event = await this.prisma.emailEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        recipient: true,
        templateKey: true,
        status: true,
        orderId: true,
      },
    });

    if (event === null) {
      throw new NotFoundException("Email event not found");
    }
    if (event.status === "SENT" || event.status === "DELIVERED") {
      throw new ConflictException(
        "This email was already delivered; retrying would send it twice",
      );
    }

    // `email_event.templateKey` is a VarChar column, so what comes back is a
    // `string`. Narrowing it through the enum schema is a real boundary check:
    // a row written by an older deploy, or by hand, must not reach a renderer
    // lookup as an unvalidated key.
    const templateKey = emailTemplateKeySchema.parse(event.templateKey);

    const suppression = await this.checkSuppression(templateKey, event.recipient);
    if (suppression !== null) {
      return { status: "suppressed", reason: suppression };
    }

    const parsed = parseTemplatePayload(templateKey, payload);
    const rendered = renderEmail(templateKey, parsed);

    return this.deliver(
      { id: event.id },
      {
        to: event.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tags: buildTags(templateKey, event.orderId),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Suppression check.
   *
   * Two carve-outs, both deliberate (see the sets in email.templates.ts):
   * internal staff alerts are not customer mail, and account-recovery mail must
   * still reach a user who is actively waiting for it — otherwise a stale bounce
   * entry permanently locks them out of their own account.
   */
  private async checkSuppression(
    templateKey: EmailTemplateKey,
    recipient: string,
  ): Promise<string | null> {
    if (
      INTERNAL_TEMPLATE_KEYS.has(templateKey) ||
      SUPPRESSION_EXEMPT_TEMPLATE_KEYS.has(templateKey)
    ) {
      return null;
    }

    try {
      const record = await this.prisma.emailSuppression.findUnique({
        where: { email: recipient },
        select: { reason: true },
      });
      return record === null ? null : record.reason;
    } catch (error) {
      // A suppression-table outage must not block transactional mail. Failing
      // OPEN is the right call: the downside is one mail to a bounced address,
      // versus every order confirmation in the system silently stopping.
      this.logger.error(
        { err: error, templateKey },
        "Suppression lookup failed; proceeding with send",
      );
      return null;
    }
  }

  /**
   * Insert the QUEUED event row, claiming the
   * `(orderId, templateKey, dedupeScope)` triple.
   *
   * SUBTLE AND IMPORTANT: in Postgres a UNIQUE index does not collide on NULL,
   * so this deduplicates only when `orderId` is non-null. That is the correct
   * semantic, not a gap — a customer may legitimately request three password
   * resets in a row, and those rows carry no order id. Order mail, which is
   * exactly what a webhook retry would duplicate, always carries one.
   *
   * Returns a discriminated result rather than throwing: an infrastructure
   * failure here must reach the caller as a value, because `send()` promises
   * never to throw and a rethrow from this depth would break that silently.
   */
  private async claim(
    templateKey: EmailTemplateKey,
    recipient: string,
    orderId: string | null,
    dedupeScope: string,
  ): Promise<
    | { kind: "claimed"; id: string }
    | { kind: "duplicate" }
    | { kind: "error"; message: string }
  > {
    try {
      const created = await this.prisma.emailEvent.create({
        data: {
          recipient,
          templateKey,
          orderId,
          dedupeScope,
          status: "QUEUED",
          attempts: 0,
        },
        select: { id: true },
      });
      return { kind: "claimed", id: created.id };
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return { kind: "duplicate" };
      }
      return { kind: "error", message: describeError(error) };
    }
  }

  /** Retry ladder + terminal event update. Never throws. */
  private async deliver(
    claim: { id: string },
    message: {
      to: string;
      subject: string;
      html: string;
      text: string;
      tags: Readonly<Record<string, string>>;
    },
  ): Promise<EmailDispatchResult> {
    let lastError = "No delivery attempt was made";

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      try {
        const { providerMessageId } = await this.transport.send(message);
        await this.markSent(claim.id, providerMessageId, attempt);
        return { status: "sent", eventId: claim.id, providerMessageId, attempts: attempt };
      } catch (error) {
        lastError = describeError(error);

        // A non-retryable failure (bad address, revoked key) fails identically
        // forever. Burning the remaining attempts only delays the DLQ signal an
        // operator needs to actually fix it.
        const retryable = !(error instanceof EmailDeliveryError) || error.retryable;
        const hasAttemptsLeft = attempt < this.retryPolicy.maxAttempts;

        this.logger.warn(
          {
            eventId: claim.id,
            attempt,
            retryable,
            reason: lastError,
            transport: this.transport.name,
          },
          "Email delivery attempt failed",
        );

        if (!retryable || !hasAttemptsLeft) {
          break;
        }
        await this.sleep(this.backoffMs(attempt));
      }
    }

    const attempts = this.retryPolicy.maxAttempts;
    await this.markFailed(claim.id, lastError, attempts);
    this.logger.error(
      { eventId: claim.id, reason: lastError },
      "Email delivery exhausted its attempts",
    );
    return { status: "failed", eventId: claim.id, error: lastError, attempts };
  }

  /** Exponential, capped. Jitter is the durable queue's job, not this loop's. */
  private backoffMs(attempt: number): number {
    const delay = this.retryPolicy.baseDelayMs * this.retryPolicy.factor ** (attempt - 1);
    return Math.min(delay, this.retryPolicy.maxDelayMs);
  }

  /**
   * Event-log writes are themselves wrapped: a database blip AFTER the provider
   * accepted the message must not turn a delivered email into a thrown
   * exception. The mail is already gone; losing the log line is the lesser
   * failure, and it is logged loudly.
   */
  private async markSent(
    eventId: string,
    providerMessageId: string,
    attempts: number,
  ): Promise<void> {
    try {
      await this.prisma.emailEvent.update({
        where: { id: eventId },
        data: {
          status: "SENT",
          providerMessageId,
          attempts,
          sentAt: new Date(),
          error: null,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, eventId, providerMessageId },
        "Email was delivered but the event log could not be updated",
      );
    }
  }

  private async markFailed(
    eventId: string,
    reason: string,
    attempts: number,
  ): Promise<void> {
    try {
      await this.prisma.emailEvent.update({
        where: { id: eventId },
        data: {
          status: "FAILED",
          attempts,
          error: reason.slice(0, MAX_ERROR_LENGTH),
        },
      });
    } catch (error) {
      this.logger.error({ err: error, eventId }, "Could not record email failure");
    }
  }

  /** Defaults exposed so a consumer can construct the service outside Nest. */
  static get defaultRetryPolicy(): EmailRetryPolicy {
    return DEFAULT_EMAIL_RETRY_POLICY;
  }
}
