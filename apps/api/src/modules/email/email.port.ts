import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";
import type { EmailTemplateKey, Locale } from "@akai/contracts";

/**
 * The ONLY config this module reads, and the ONLY logger surface it uses.
 *
 * Narrowed with `Pick` rather than taking the whole `ServerEnv`/`Logger`
 * because a dependency you cannot construct is a dependency you cannot test:
 * with the full types, every test has to fabricate ~30 unrelated env vars or a
 * complete pino instance, and the usual escape from that is an `as unknown as`
 * cast — which throws away the checking the types were there to provide.
 *
 * Narrow types also document the real coupling: this module needs three env
 * vars and one log method, and nothing here can quietly start reading
 * DATABASE_URL.
 */
export type EmailTransportConfig = Pick<
  ServerEnv,
  "EMAIL_TRANSPORT" | "RESEND_API_KEY" | "EMAIL_FROM"
>;

export type TransportLogger = Pick<Logger, "info">;

/**
 * THE DRIVEN PORT — the seam between "what we send" and "who sends it".
 *
 * NOTE ON @akai/contracts' `EmailPort`: that interface is
 * template-key-plus-data shaped, i.e. it assumes PROVIDER-SIDE templating. We
 * render locally instead (spec §10 puts templates in the repo, in both locales,
 * unit-testable without a network), so the transport needs an already-rendered
 * subject/html/text and knows nothing about templates.
 *
 * Both exist deliberately and at different levels: `EmailTransport` is the
 * provider adapter, `EmailPort` stays the application-facing interface that
 * other modules type against — and `EmailService` implements it, so
 * `FakeEmailPort` from @akai/testing remains a drop-in double for consumers.
 */
export interface RenderedMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Correlation only; providers echo it back on bounce/complaint webhooks. */
  readonly tags: Readonly<Record<string, string>>;
}

export interface TransportResult {
  readonly providerMessageId: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: RenderedMessage): Promise<TransportResult>;
}

/** DI token for the transport. Overriding THIS is how a test avoids the network. */
export const EMAIL_TRANSPORT = Symbol("EMAIL_TRANSPORT");

/** DI token for the sleep function, so retry tests do not spend real seconds. */
export const EMAIL_SLEEPER = Symbol("EMAIL_SLEEPER");

export type Sleeper = (milliseconds: number) => Promise<void>;

/**
 * A delivery failure, classified.
 *
 * `retryable` is the whole point. Retrying a 422 "invalid recipient" wastes the
 * budget and delays the DLQ signal, while NOT retrying a 429 or a 503 throws
 * away an order confirmation over a transient blip. The provider adapter owns
 * this classification because only it knows the provider's status semantics.
 */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

export interface EmailRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
}

export const EMAIL_RETRY_POLICY = Symbol("EMAIL_RETRY_POLICY");

/**
 * Three attempts over ~3 seconds.
 *
 * Kept deliberately SHORT because this retry loop runs in-process. Long
 * in-process backoff holds a worker slot hostage to a degraded provider; the
 * durable, minutes-to-hours retry belongs to the pg-boss `email` queue
 * (spec §5), which this module is designed to hand off to unchanged — the
 * transport, renderer and event log are all already queue-agnostic.
 */
export const DEFAULT_EMAIL_RETRY_POLICY: EmailRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  factor: 4,
  maxDelayMs: 5_000,
};

/** Tag values are sent to a third party; keep them free of PII by construction. */
export function buildTags(
  templateKey: EmailTemplateKey,
  locale: Locale,
  orderId: string | null,
): Readonly<Record<string, string>> {
  return orderId === null
    ? { template: templateKey, locale }
    : { template: templateKey, locale, order_id: orderId };
}
