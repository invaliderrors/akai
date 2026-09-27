/**
 * A Sendcloud call that did not produce a usable answer.
 *
 * Deliberately NOT an `HttpException`: this is a VENDOR fault, and the module
 * that called Sendcloud decides what it means for our caller — the pickup-point
 * search turns any of these into `UNAVAILABLE`, the label service records a
 * FAILED shipment, the admin endpoint answers a coded 409. Letting one escape a
 * controller as-is lands as a 500 through the global filter, which is correct:
 * reaching a controller unhandled IS our bug.
 *
 *  - `status` — the HTTP status Sendcloud answered, or 0 when there was no
 *    answer (network failure, our timeout).
 *  - `code`   — Sendcloud's JSON:API error code (`not_found`, `invalid`,
 *    `parcel_announcement_error`, …), or one of ours: `network_error`,
 *    `timeout`, `malformed_response`, `unknown`.
 *  - `detail` — Sendcloud's own sentence. For OUR logs and for staff (a FAILED
 *    shipment's `failureReason`) — never rendered to a customer.
 */
export class SendcloudError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly detail: string;

  constructor(status: number, code: string, detail: string) {
    super(`Sendcloud ${status === 0 ? "request" : status} ${code}: ${detail}`);
    this.name = "SendcloudError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** Worth another attempt: rate-limited, a transient upstream fault, or no answer at all. */
  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** 429, the transient 5xx gateway family, and "no response" (0). */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status === 502 || status === 503 || status === 504;
}
