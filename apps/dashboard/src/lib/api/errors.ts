import { errorEnvelopeSchema, type ErrorCode, type FieldError } from "@akai/contracts";

/**
 * The client-side view of an API failure.
 *
 * Every non-2xx response in the platform is `errorEnvelopeSchema` (spec §7,
 * guaranteed by the API's global exception filter). This narrows it to the flat
 * shape a component actually wants, and — critically — GUARANTEES that shape
 * even when the failure never reached the API at all (DNS, TLS, timeout, a
 * proxy's HTML error page). Callers therefore branch on `code` and never have
 * to ask "is this an envelope or a network error".
 */
export interface ApiError {
  readonly code: ErrorCode;
  readonly message: string;
  /** Populated only for VALIDATION_FAILED. Null, never undefined, so `in` checks are unnecessary. */
  readonly fields: readonly FieldError[] | null;
  /**
   * The domain sub-code that narrows `code`, or null when the failure carried
   * none — a coupon refused for being below its minimum and one refused for
   * having expired are both VALIDATION_FAILED, and only this tells them apart.
   *
   * PARSED against a domain enum from @akai/contracts, never rendered; and
   * null, never undefined, for the same reason `fields` is.
   */
  readonly reason: string | null;
  /** Quotable by a user to support; empty only for failures that never reached the API. */
  readonly requestId: string;
}

/**
 * A request outcome. A discriminated union rather than throw/catch: an API 409
 * is an ordinary, expected result that the UI renders, not an exception. Making
 * it a return value means the compiler forces every caller to handle it, which
 * `throw` cannot do.
 */
export type ApiResult<T> =
  | {
      readonly ok: true;
      readonly status: number;
      readonly data: T;
      /**
       * The raw response headers. Optional so every existing hand-written test
       * fake for this shape (there is no mocking library standing between them
       * and `apiRequest`) keeps compiling without adding one — a fake that omits
       * it is saying "no header behaviour is under test here", which is true
       * for the overwhelming majority of call sites. `apiRequest` itself always
       * sets it.
       */
      readonly headers?: Headers;
    }
  | { readonly ok: false; readonly status: number; readonly error: ApiError };

export function apiFailure(status: number, error: ApiError): ApiResult<never> {
  return { ok: false, status, error };
}

/**
 * Builds an ApiError from an already-parsed response body.
 *
 * When the body is not a valid envelope the response did NOT come from our API
 * — it is a load balancer's 502 page or a proxy's timeout. Synthesising a
 * well-formed error here is what stops `error.message.toUpperCase()` from
 * throwing on `undefined` three layers up.
 */
export function toApiError(status: number, body: unknown): ApiError {
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    return {
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      fields: parsed.data.error.fields ?? null,
      reason: parsed.data.error.reason ?? null,
      requestId: parsed.data.error.requestId,
    };
  }

  return {
    code: inferCodeFromStatus(status),
    message: "The service returned an unexpected response.",
    fields: null,
    reason: null,
    requestId: "",
  };
}

/**
 * Best-effort status → code mapping for responses that bypassed the API's
 * exception filter. Only the statuses an intermediary realistically produces
 * are mapped; everything else is INTERNAL_ERROR, which is the honest answer.
 */
function inferCodeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RATE_LIMITED";
    default:
      return "INTERNAL_ERROR";
  }
}

/** The error used when the request never produced an HTTP response at all. */
export function networkError(message: string): ApiError {
  return {
    code: "INTERNAL_ERROR",
    message,
    fields: null,
    reason: null,
    requestId: "",
  };
}

/**
 * The error used when a 2xx response does not match its declared schema.
 *
 * Deliberately a FAILURE rather than a pass-through. A response that has
 * drifted from the contract is a bug we want surfaced at the boundary, not
 * `undefined` propagating into a component that renders `order.grandTotal`.
 */
export function contractViolationError(path: string): ApiError {
  return {
    code: "INTERNAL_ERROR",
    message: `The API response for ${path} did not match its contract.`,
    fields: null,
    reason: null,
    requestId: "",
  };
}
