import { serverEnv } from "../env";
import { getSession } from "../session/server";
import type { SessionPayload } from "@akai/session";
import { apiRequest, type ApiRequestOptions, type HttpMethod, type Schema } from "./http";
import type { ApiResult } from "./errors";

/**
 * The server-side API client every dashboard feature uses.
 *
 * This is the seam other slices code against. A page or route handler does:
 *
 * ```ts
 * const api = await createServerApiClient();
 * const orders = await api.get("/orders", paginatedSchema(orderSchema));
 * if (!orders.ok) return <ErrorState error={orders.error} />;
 * ```
 *
 * It resolves the bearer token from the sealed session cookie, so no feature
 * module ever touches token material — which is the whole point of the BFF. A
 * feature that finds itself reading `session.accessToken` directly is doing
 * something this client should be doing instead.
 */

export function apiBaseUrl(): string {
  return serverEnv().API_INTERNAL_URL;
}

/** Options a caller supplies; `baseUrl` and the bearer token are injected. */
export type ClientRequestOptions<T> = Omit<
  ApiRequestOptions<T>,
  "baseUrl" | "accessToken"
>;

export interface ServerApiClient {
  /** True when a session was found. False means every call is anonymous. */
  readonly authenticated: boolean;
  /** Identity for rendering. Null when anonymous. Never use for authorisation. */
  readonly session: SessionPayload | null;

  request<T>(options: ClientRequestOptions<T>): Promise<ApiResult<T>>;
  get<T>(path: string, schema: Schema<T>): Promise<ApiResult<T>>;
  post<T>(path: string, schema: Schema<T>, body?: unknown): Promise<ApiResult<T>>;
  patch<T>(path: string, schema: Schema<T>, body?: unknown): Promise<ApiResult<T>>;
  put<T>(path: string, schema: Schema<T>, body?: unknown): Promise<ApiResult<T>>;
  delete<T>(path: string, schema: Schema<T>): Promise<ApiResult<T>>;
}

/**
 * Builds a client bound to an explicit session.
 *
 * Exported separately from `createServerApiClient` so tests — and any caller
 * that already resolved a session — can construct one without Next's request
 * context. No hidden global state.
 */
export function createApiClient(
  baseUrl: string,
  session: SessionPayload | null,
): ServerApiClient {
  const accessToken = session?.accessToken ?? null;

  async function request<T>(options: ClientRequestOptions<T>): Promise<ApiResult<T>> {
    return apiRequest<T>({ ...options, baseUrl, accessToken });
  }

  function withBody<T>(
    method: HttpMethod,
    path: string,
    schema: Schema<T>,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    return request<T>({
      method,
      path,
      schema,
      // A key present with value `undefined` is not the same as an absent key
      // once it reaches `JSON.stringify` inside a `.strict()` contract, so the
      // key is omitted rather than set to undefined.
      ...(body === undefined ? {} : { body }),
    });
  }

  return {
    authenticated: session !== null,
    session,
    request,
    get: (path, schema) => request({ method: "GET", path, schema }),
    post: (path, schema, body) => withBody("POST", path, schema, body),
    patch: (path, schema, body) => withBody("PATCH", path, schema, body),
    put: (path, schema, body) => withBody("PUT", path, schema, body),
    delete: (path, schema) => request({ method: "DELETE", path, schema }),
  };
}

/**
 * The request-scoped client.
 *
 * NOTE ON 401s: this client does NOT refresh. Next forbids cookie writes from a
 * server component, so a refresh here could rotate the token pair with nowhere
 * to persist the result — and since refresh tokens are single-use, the rotated
 * pair would be lost and the user signed out. Refresh is therefore owned by
 * middleware, which runs before rendering and CAN write cookies (see
 * `src/middleware.ts`). A 401 reaching a page means the session genuinely died
 * mid-request; treat it as a redirect to sign-in, never as a retry loop.
 */
export async function createServerApiClient(): Promise<ServerApiClient> {
  return createApiClient(apiBaseUrl(), await getSession());
}

/** A client with no credentials, for the pre-authentication BFF routes. */
export function createAnonymousApiClient(): ServerApiClient {
  return createApiClient(apiBaseUrl(), null);
}
