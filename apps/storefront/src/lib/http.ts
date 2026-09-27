import { errorEnvelopeSchema, type ErrorEnvelope } from "@akai/contracts";
import type { z } from "zod";

/**
 * The ONE fetch wrapper. Used on the server (base = API_INTERNAL_URL) and in
 * islands (base = PUBLIC_API_URL, passed down as a prop), so it takes the base
 * URL as an argument rather than guessing which side it runs on.
 *
 * Every response is parsed through its contract schema: a shape the API did
 * not promise is an error here, not a crash three components later.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly envelope: ErrorEnvelope | null,
  ) {
    super(envelope?.error.message ?? `API request failed with status ${String(status)}`);
    this.name = "ApiError";
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiRequest<S extends z.ZodTypeAny> {
  readonly baseUrl: string;
  readonly path: string;
  readonly schema: S;
  readonly method?: HttpMethod;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly headers: Headers;
}

export async function apiRequest<S extends z.ZodTypeAny>(
  request: ApiRequest<S>,
): Promise<ApiResponse<z.output<S>>> {
  const url = new URL(`${request.baseUrl.replace(/\/+$/, "")}/v1${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: request.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      ...request.headers,
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(payload);
    throw new ApiError(response.status, envelope.success ? envelope.data : null);
  }

  return { data: request.schema.parse(payload) as z.output<S>, headers: response.headers };
}
