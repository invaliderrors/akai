import type { z } from "zod";
import {
  apiFailure,
  contractViolationError,
  networkError,
  toApiError,
  type ApiResult,
} from "./errors";

/**
 * The one place this app talks HTTP to the NestJS API.
 *
 * Two invariants make everything above it typesafe:
 *
 * 1. Every caller supplies a zod schema, and the response is PARSED against it.
 *    The returned `T` is therefore a fact about the bytes on the wire, not a
 *    developer's assertion about them. `res.json() as Order` is the exact hole
 *    spec §7 exists to close, and it is closed here rather than politely
 *    avoided at each call site.
 * 2. Nothing throws. Failures come back as `{ ok: false }`, so the compiler
 *    forces callers to handle them.
 *
 * Runtime-agnostic on purpose: it uses only `fetch`, so middleware (Edge),
 * route handlers and server components all share one implementation.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * A schema that PARSES an unknown input into `T`.
 *
 * The third type argument matters. `z.ZodType<T>` defaults its input type to
 * `T`, which silently demands that a schema's input and output be identical —
 * so any schema using `.default()`, `.transform()` or `.passthrough()` (an
 * emailSchema that lower-cases, a paginated envelope, an order detail) is
 * rejected at the call site with an inscrutable variance error. Declaring the
 * input as `unknown` says what is actually true here: the value came off the
 * wire and its shape is not known until this schema has run.
 */
export type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

export interface ApiRequestOptions<T> {
  readonly baseUrl: string;
  readonly method: HttpMethod;
  /** Path beneath the API's `/v1` prefix, e.g. `/auth/login`. */
  readonly path: string;
  /** Schema the 2xx body must satisfy. Use `z.undefined()` for 204 endpoints. */
  readonly schema: Schema<T>;
  readonly body?: unknown;
  /** Bearer credential. Never forwarded to the browser. */
  readonly accessToken?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Correlates this request with the API's logs; generated when omitted. */
  readonly requestId?: string;
}

/** The API mounts everything under a version prefix (apps/api/src/main.ts). */
export const API_VERSION_PREFIX = "/v1";

export function buildUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const normalisedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${API_VERSION_PREFIX}${normalisedPath}`;
}

export async function apiRequest<T>(options: ApiRequestOptions<T>): Promise<ApiResult<T>> {
  const url = buildUrl(options.baseUrl, options.path);
  const requestId = options.requestId ?? crypto.randomUUID();

  const headers: Record<string, string> = {
    accept: "application/json",
    // Propagated end-to-end so one id ties a browser action to an API log line
    // to a queued job (spec §6).
    "x-request-id": requestId,
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.accessToken !== undefined && options.accessToken !== null) {
    headers.authorization = `Bearer ${options.accessToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // The API is the source of truth for mutable commerce state; a cached
      // order list is a support ticket. ISR belongs on the public storefront,
      // not on an authenticated dashboard.
      cache: "no-store",
      // Server-to-server with an explicit bearer token. Sending ambient
      // credentials would be meaningless here and confusing at the API's CORS layer.
      credentials: "omit",
    });
  } catch (cause) {
    return apiFailure(
      0,
      networkError(
        cause instanceof Error
          ? `Could not reach the API: ${cause.message}`
          : "Could not reach the API.",
      ),
    );
  }

  const payload = await readJsonBody(response);

  if (!response.ok) {
    return apiFailure(response.status, toApiError(response.status, payload));
  }

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    return apiFailure(response.status, contractViolationError(options.path));
  }

  return { ok: true, status: response.status, data: parsed.data, headers: response.headers };
}

/**
 * Reads a response body as `unknown`.
 *
 * Returns `undefined` for an empty body (204, and 200s that legitimately send
 * nothing) so a `z.undefined()` schema matches. Returns `undefined` for
 * unparseable bodies too — a proxy's HTML error page then falls through to
 * `toApiError`'s synthetic envelope rather than crashing the parse.
 *
 * The `unknown` annotation is the important part: `JSON.parse` is typed `any`,
 * and letting that `any` escape this function would silently disable type
 * checking for every caller downstream.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }

  if (text.trim() === "") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}
