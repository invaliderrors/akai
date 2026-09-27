import type { Schema } from "../api/http";
import { errorEnvelopeSchema, type ErrorCode, type FieldError } from "@akai/contracts";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@akai/session";

/**
 * The browser's only way to talk to the BFF.
 *
 * Every auth form goes through this. It injects the CSRF header, parses the
 * response against a schema, and normalises EVERY failure — HTTP error,
 * malformed body, offline — into one shape. Components therefore render
 * `result.error.message` without a single defensive check, which is what stops
 * error handling from being reinvented (differently) in each form.
 *
 * Note this never sees a token: it posts to same-origin `/api/auth/*` and the
 * session travels as an httpOnly cookie the script cannot read.
 */

export interface BffError {
  readonly code: ErrorCode;
  readonly message: string;
  /** Field-level problems, for highlighting individual inputs. */
  readonly fields: readonly FieldError[] | null;
  readonly requestId: string;
}

export type BffResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: BffError };

/**
 * Reads a non-httpOnly cookie.
 *
 * The value is decoded because a cookie value is percent-encoded in transit;
 * comparing the raw form against the server's decoded one is a
 * constant-time-equal that is never equal. Base64url tokens happen not to
 * contain encodable characters today, which is exactly why this bug would lie
 * dormant until the token format changed.
 */
export function readCookie(name: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    if (rawKey?.trim() === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

const OFFLINE_ERROR: BffError = {
  code: "INTERNAL_ERROR",
  message: "Could not reach the server. Check your connection and try again.",
  fields: null,
  requestId: "",
};

function malformedResponse(): BffError {
  return {
    code: "INTERNAL_ERROR",
    message: "The server returned an unexpected response.",
    fields: null,
    requestId: "",
  };
}

/** POSTs JSON to a BFF route and validates the success body against `schema`. */
export async function postJson<T>(
  path: string,
  body: unknown,
  schema: Schema<T>,
): Promise<BffResult<T>> {
  const csrfToken = readCookie(CSRF_COOKIE_NAME);

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Absent when middleware has not yet issued one. The request is sent
        // anyway so the server produces the real 403 rather than this layer
        // inventing a different failure for the same cause.
        ...(csrfToken === null ? {} : { [CSRF_HEADER_NAME]: csrfToken }),
      },
      body: JSON.stringify(body),
      // Same-origin: the httpOnly session cookie must ride along.
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, error: OFFLINE_ERROR };
  }

  const payload = await readJson(response);

  if (!response.ok) {
    const parsed = errorEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: malformedResponse() };
    }
    return {
      ok: false,
      error: {
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        fields: parsed.data.error.fields ?? null,
        requestId: parsed.data.error.requestId,
      },
    };
  }

  const parsed = schema.safeParse(payload);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: malformedResponse() };
}

/** `JSON.parse` is `any`; the `unknown` annotation stops it escaping. */
async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.trim() === "") {
      return undefined;
    }
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}
