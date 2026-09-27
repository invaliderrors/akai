import { z } from "zod";
import type { ServerApiClient } from "../api/client";
import { buildQueryString, type AdminHttp, type AdminHttpRequest } from "./http";

/**
 * Adapts the auth-shell slice's `ServerApiClient` to the admin `AdminHttp` port.
 *
 * The shared client keeps ownership of everything that should only exist once:
 * the base URL, the bearer token resolved from the sealed session cookie, the
 * x-request-id propagation, the error-envelope narrowing and the network-failure
 * synthesis. This adapter adds exactly two things it cannot do:
 *
 *  1. Contract parsing that preserves branded types. It is handed `z.unknown()`
 *     and the admin layer parses the body itself — see the long note in http.ts
 *     for why `z.ZodType<T>` silently strips the `Minor` brand. Once the shared
 *     client widens its schema parameter, this collapses to a passthrough.
 *
 *  2. `Idempotency-Key`. The shared client accepts arbitrary headers, so this is
 *     a straight forward; it lives here so no admin call site has to remember
 *     the header's exact spelling.
 *
 * The `ok/error` union is re-thrown as an `AdminApiError`-shaped response rather
 * than propagated: admin pages are server components that render an error
 * boundary, and threading a union through thirty call sites to reconstruct the
 * same status/body pair at each one buys nothing.
 */
export function createAdminHttp(api: ServerApiClient): AdminHttp {
  return {
    async request(input: AdminHttpRequest) {
      const path = `${input.path}${
        input.query === undefined ? "" : buildQueryString(input.query)
      }`;

      const result = await api.request<unknown>({
        method: input.method,
        path,
        // Transport-level only. The real contract parse happens in parseOrThrow,
        // where the Input parameter is `unknown` and the brand survives.
        schema: z.unknown(),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { headers: { "idempotency-key": input.idempotencyKey } }),
      });

      if (result.ok) {
        return {
          status: result.status,
          body: result.data,
          ...(result.headers === undefined
            ? {}
            : { headers: Object.fromEntries(result.headers.entries()) }),
        };
      }

      // Rebuild the envelope the admin layer's `toApiError` expects. The shared
      // client has already narrowed a network failure or a proxy's HTML page
      // into this same shape, so downstream code sees one error vocabulary
      // whether the failure came from the API or from the wire.
      return {
        status: result.status,
        body: {
          error: {
            code: result.error.code,
            message: result.error.message,
            ...(result.error.fields === null ? {} : { fields: result.error.fields }),
            // Rebuilt too, or the sub-code dies here: `toApiError` re-parses
            // this object against the envelope schema, and what is not written
            // back is simply gone by the time an admin page sees the error.
            ...(result.error.reason === null ? {} : { reason: result.error.reason }),
            requestId: result.error.requestId,
            timestamp: new Date().toISOString(),
          },
        },
      };
    },
  };
}
