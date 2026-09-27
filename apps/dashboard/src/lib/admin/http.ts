import { z } from "zod";
import { errorEnvelopeSchema, type ErrorCode } from "@akai/contracts";

/**
 * The HTTP port the admin data layer talks to.
 *
 * WHY A PORT AT ALL, given the auth-shell slice already ships `ServerApiClient`:
 * two reasons, one structural and one that is an outright correctness bug.
 *
 * 1. Testability. Every admin API function takes an `AdminHttp`, so the whole
 *    layer is exercised with a hand-written fake — no `vi.stubGlobal('fetch')`,
 *    no Next request context, no sealed session cookie.
 *
 * 2. THE BRAND. `ServerApiClient`'s methods are typed
 *    `get<T>(path, schema: z.ZodType<T>)`. `z.ZodType<T>` defaults its Input
 *    parameter to equal its Output, so it does not match ANY schema carrying a
 *    `.transform()` — and every money field in the platform carries one, because
 *    that is how `nonNegativeMinorSchema` mints the `Minor` brand. Passing
 *    `productSchema` there compiles, silently infers `T` from the INPUT side,
 *    and hands back `price.net: number` where the contract says `Minor`. The
 *    brand vanishes at precisely the boundary it exists to guard, with nothing
 *    failing to compile. (Verified: assigning that `net` to a plain `number`
 *    is accepted; passing an explicit `z.ZodType<Product>` is rejected.)
 *
 *    So the adapter hands `z.unknown()` to the shared client — which still does
 *    the transport, auth, error-envelope and network-failure work — and does the
 *    CONTRACT parse here, through `parseOrThrow`, whose Input parameter is
 *    `unknown` and therefore preserves the brand.
 *
 * Reported upstream in followUps: widening `ApiRequestOptions.schema` to
 * `z.ZodType<T, z.ZodTypeDef, unknown>` fixes this for every slice at once, and
 * this adapter's parse step collapses to a passthrough the day it lands.
 */

export interface AdminHttpRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path beneath the API's `/v1` prefix, e.g. "/admin/products". */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  /**
   * Sent as the `Idempotency-Key` header. Required by the API on money-creating
   * POSTs and on bulk import (spec §9): a duplicate key replays the stored
   * response, the same key with a different body is a 409.
   */
  readonly idempotencyKey?: string;
}

export interface AdminHttpResponse {
  readonly status: number;
  /** Deliberately `unknown` — it is parsed, never asserted. See parseOrThrow. */
  readonly body: unknown;
  /**
   * Out-of-band response headers, lower-cased by name. Optional so every
   * hand-written `AdminHttp` fake in this layer's tests keeps compiling without
   * adding one — most calls have nothing to read here. `createAdminHttp`
   * always sets it for a real request.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AdminHttp {
  request(input: AdminHttpRequest): Promise<AdminHttpResponse>;
}

/**
 * A failed API call, carrying the machine-readable code so callers branch on
 * `code` rather than on a status number or a human-facing message string.
 */
export class AdminApiError extends Error {
  readonly code: ErrorCode | "UNPARSEABLE_RESPONSE";
  readonly status: number;
  readonly fields: readonly { readonly path: string; readonly message: string }[];
  /**
   * The envelope's domain sub-code, or null. `code` is a platform-wide enum and
   * is therefore too coarse for failures that share one — every discount
   * refusal is VALIDATION_FAILED — so this is what a caller branches on to tell
   * "below the minimum" from "expired". Parsed against a domain enum from
   * @akai/contracts; never shown to anyone.
   */
  readonly reason: string | null;
  readonly requestId: string | null;

  constructor(init: {
    code: ErrorCode | "UNPARSEABLE_RESPONSE";
    status: number;
    message: string;
    fields?: readonly { readonly path: string; readonly message: string }[];
    reason?: string | null;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = "AdminApiError";
    this.code = init.code;
    this.status = init.status;
    this.fields = init.fields ?? [];
    this.reason = init.reason ?? null;
    this.requestId = init.requestId ?? null;
  }
}

/**
 * Validate a response body against the schema the caller expects.
 *
 * EVERY response goes through here. The API is a separate deployable that rolls
 * forward independently, so its output is external input to this app and gets
 * parsed like any other (spec §7). Casting `response.body as Product` would let
 * a field the API renamed surface as `undefined` three components deep and
 * render "undefined" into a price cell, rather than failing where the mismatch
 * actually happened.
 */
export function parseOrThrow<TOutput>(
  /**
   * The third type parameter (Input) is `unknown`, and it is load-bearing —
   * see the note at the top of this file. `z.ZodType<TOutput>` alone silently
   * strips the `Minor` brand from every money field.
   */
  schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>,
  response: AdminHttpResponse,
): TOutput {
  if (response.status >= 400) {
    throw toApiError(response);
  }

  const parsed = schema.safeParse(response.body);
  if (!parsed.success) {
    throw new AdminApiError({
      code: "UNPARSEABLE_RESPONSE",
      status: response.status,
      message:
        "The API returned a response this dashboard does not understand. " +
        "This usually means the API and dashboard versions have diverged.",
      fields: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

/**
 * Turn an error response into a typed error.
 *
 * Falls back to a synthetic INTERNAL_ERROR when the body is not the documented
 * envelope — a proxy timing out returns HTML, and a client that assumes JSON on
 * the error path crashes exactly when something is already wrong.
 */
export function toApiError(response: AdminHttpResponse): AdminApiError {
  const envelope = errorEnvelopeSchema.safeParse(response.body);

  if (!envelope.success) {
    return new AdminApiError({
      code: "INTERNAL_ERROR",
      status: response.status,
      message: `Request failed with status ${response.status}.`,
    });
  }

  const { error } = envelope.data;
  return new AdminApiError({
    code: error.code,
    status: response.status,
    message: error.message,
    fields: error.fields ?? [],
    reason: error.reason ?? null,
    requestId: error.requestId,
  });
}

/** Serialise a query object, dropping undefined so absent filters vanish. */
export function buildQueryString(
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const serialised = params.toString();
  return serialised.length === 0 ? "" : `?${serialised}`;
}
