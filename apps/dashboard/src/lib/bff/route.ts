import { NextResponse, type NextRequest } from "next/server";
import type { Schema } from "../api/http";
import type { ErrorCode } from "@akai/contracts";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../session/cookies";
import { verifyCsrf } from "@akai/session";
import type { ApiError, ApiResult } from "../api/errors";

/**
 * Shared plumbing for the auth BFF route handlers.
 *
 * These handlers are the ONLY part of the dashboard the browser posts to. They
 * hold the token pair, set the sealed cookie, and return bodies that contain no
 * token material whatsoever. Everything in this file exists to make that
 * boundary uniform, because a single handler that formats its errors
 * differently forces every form component to special-case it.
 *
 * Responses reuse the platform error envelope (spec §7) so the browser has ONE
 * error parser regardless of whether the failure originated here or at the API.
 */

export interface EnvelopeBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
    readonly requestId: string;
    readonly timestamp: string;
  };
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  fields?: readonly { readonly path: string; readonly message: string }[],
): NextResponse<EnvelopeBody> {
  return NextResponse.json<EnvelopeBody>(
    {
      error: {
        code,
        message,
        ...(fields === undefined ? {} : { fields }),
        requestId: "",
        timestamp: new Date().toISOString(),
      },
    },
    { status },
  );
}

/** Re-emits an API failure verbatim, preserving its code and requestId. */
export function forwardApiError(status: number, error: ApiError): NextResponse<EnvelopeBody> {
  return NextResponse.json<EnvelopeBody>(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields === null ? {} : { fields: error.fields }),
        requestId: error.requestId,
        timestamp: new Date().toISOString(),
      },
    },
    { status: status === 0 ? 502 : status },
  );
}

/**
 * Enforces the double-submit CSRF pair on a mutating request.
 *
 * Applied to EVERY handler here, including the unauthenticated ones. Uniformity
 * is the point: a per-endpoint judgement about which routes "need" CSRF is a
 * judgement that will eventually be made wrong, and middleware guarantees the
 * cookie exists on the very first request, so there is no cost to applying it
 * everywhere.
 */
export function csrfFailure(request: NextRequest): NextResponse<EnvelopeBody> | null {
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  const headerToken = request.headers.get(CSRF_HEADER_NAME);

  if (verifyCsrf(cookieToken, headerToken)) {
    return null;
  }

  return errorResponse(403, "FORBIDDEN", "Invalid or missing CSRF token.");
}

/**
 * Parses and validates a request body.
 *
 * Returns a discriminated result rather than throwing, and — importantly —
 * reports zod's field paths back to the browser in the envelope's `fields`, so a
 * form can highlight the offending input instead of showing one generic banner.
 *
 * `request.json()` is typed `any`; capturing it as `unknown` here is what stops
 * that `any` from spreading into every handler (one of the three implicit-any
 * holes spec §7 calls out).
 */
export type BodyResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: NextResponse<EnvelopeBody> };

export async function parseBody<T>(
  request: NextRequest,
  schema: Schema<T>,
): Promise<BodyResult<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: errorResponse(400, "VALIDATION_FAILED", "Malformed JSON body.") };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: errorResponse(
        400,
        "VALIDATION_FAILED",
        "Some fields need attention.",
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

/**
 * Narrows an ApiResult to its success branch or produces the forwarded error.
 *
 * Exists so handlers read as a straight line of guard clauses instead of
 * repeating the same `if (!result.ok) return forwardApiError(...)` shape.
 */
export function unwrap<T>(
  result: ApiResult<T>,
): { readonly ok: true; readonly data: T } | { readonly ok: false; readonly response: NextResponse<EnvelopeBody> } {
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, response: forwardApiError(result.status, result.error) };
}
