import { z } from "zod";
import {
  EmailDeliveryError,
  type EmailTransport,
  type RenderedMessage,
  type TransportResult,
} from "../email.port";

/**
 * Resend adapter, over `fetch`.
 *
 * Written against the REST endpoint rather than the `resend` SDK on purpose:
 * the SDK returns a loosely-typed `{ data, error }` union that would need
 * narrowing anyway, and adding a dependency to the shared root package.json
 * would collide with the other agents working in this repo right now. The wire
 * response is parsed with zod, so the typing here is *stronger* than the SDK's,
 * not weaker — `unknown` in, narrowed out, exactly the external-data rule.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Only the field we consume. `.passthrough()` (not `.strict()`) because this is
 * a RESPONSE, not a request: Resend adding a field must not break delivery.
 * Strictness belongs on input we control, not on a third party's output.
 */
const resendSuccessSchema = z.object({ id: z.string().min(1) }).passthrough();

const resendErrorSchema = z
  .object({
    message: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export interface ResendTransportOptions {
  readonly apiKey: string;
  readonly from: string;
  /** Injected so tests exercise the real parsing/classification without network. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class ResendTransport implements EmailTransport {
  readonly name = "resend";

  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ResendTransportOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(message: RenderedMessage): Promise<TransportResult> {
    const response = await this.post(message);
    const status = response.status;
    const body: unknown = await this.readJson(response);

    if (!response.ok) {
      throw new EmailDeliveryError(
        this.describeFailure(status, body),
        this.isRetryableStatus(status),
        status,
      );
    }

    const parsed = resendSuccessSchema.safeParse(body);
    if (!parsed.success) {
      // A 200 whose body we cannot read means we do NOT have a message id, so
      // we cannot correlate a later bounce webhook. Treat it as retryable:
      // Resend deduplicates on its side, and a duplicate is strictly better
      // than an order confirmation recorded as sent that never went out.
      throw new EmailDeliveryError(
        "Resend returned a success status with an unrecognised body shape",
        true,
        status,
      );
    }

    return { providerMessageId: parsed.data.id };
  }

  private async post(message: RenderedMessage): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      return await this.fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // A network error, DNS failure or our own abort. All transient by nature.
      // The message is OURS, never the thrown object's: a fetch error can carry
      // the full request including the Authorization header.
      throw new EmailDeliveryError(
        error instanceof Error && error.name === "AbortError"
          ? `Resend request timed out after ${this.timeoutMs}ms`
          : "Resend request failed at the network layer",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Build the operator-facing failure string.
   *
   * Deliberately assembled from the STATUS plus a length-capped provider
   * message, never from the raw response object — and the API key is never in
   * scope here. This string is persisted on `email_event.error` and surfaced in
   * the admin UI, so anything it contains is effectively public to staff.
   */
  private describeFailure(status: number, body: unknown): string {
    const parsed = resendErrorSchema.safeParse(body);
    const detail =
      parsed.success && parsed.data.message !== undefined
        ? this.redactSecrets(parsed.data.message).slice(0, 300)
        : "no detail provided";
    return `Resend rejected the message (HTTP ${status}): ${detail}`;
  }

  /**
   * Scrub credentials out of a provider-supplied string.
   *
   * An authentication error commonly echoes the offending credential back, and
   * this string is persisted to `email_event.error` and rendered in the admin
   * UI — so an un-scrubbed 401 body is how a live API key ends up in the
   * database, in application logs, and in a screenshot pasted into a ticket.
   *
   * Both our own key (exact match) and the general `re_`/`sk_` token shapes are
   * removed, because the echoed value is not always byte-identical to ours.
   */
  private redactSecrets(message: string): string {
    return message
      .split(this.apiKey)
      .join("[redacted]")
      .replace(/\b(?:re|sk|whsec)_[A-Za-z0-9_-]{8,}/g, "[redacted]");
  }

  /**
   * 429 and 5xx are transient. 4xx is not: a malformed address or a revoked key
   * will fail identically on every retry, and retrying only delays the DLQ
   * signal an operator needs to actually fix it.
   */
  private isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }
}
