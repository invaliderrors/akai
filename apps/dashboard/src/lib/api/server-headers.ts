import { headers } from "next/headers";
import { getSession } from "../session/server";

/**
 * Per-request outbound headers for the NestJS API.
 *
 * This is the integration seam the account and admin slices asked the auth
 * shell to own: their transports accept a `headers: () => Promise<Record<...>>`
 * and deliberately do not read cookies themselves. Pass this function and they
 * are correctly authenticated with no other change.
 *
 * ---------------------------------------------------------------------------
 * WHY A BEARER TOKEN AND NOT A FORWARDED COOKIE.
 *
 * Forwarding `akai_session` to the API cannot work, and it is worth being
 * explicit because it is the intuitive thing to reach for. The API authenticates
 * with `Authorization: Bearer <access JWT>` — see
 * `apps/api/src/modules/auth/guards/jwt-auth.guard.ts`, which reads the
 * Authorization header and nothing else. `akai_session` is an AES-GCM
 * ciphertext that only THIS app holds the key for; the API would receive an
 * opaque blob it cannot decrypt, find no bearer token, and 401 every request.
 *
 * That asymmetry is the BFF pattern working as intended: the browser holds an
 * opaque cookie, this process holds the tokens, the API sees only bearer tokens.
 * ---------------------------------------------------------------------------
 *
 * A FUNCTION, never a captured value. Resolving headers once at module scope
 * would freeze one customer's token into a module singleton and serve their
 * orders to whoever requested next — the classic Next.js cross-request leak.
 */
export async function serverAuthHeaders(): Promise<Readonly<Record<string, string>>> {
  const session = await getSession();
  const result: Record<string, string> = {};

  if (session !== null) {
    result.authorization = `Bearer ${session.accessToken}`;
  }

  // Propagate the inbound request id so one identifier spans browser action →
  // dashboard render → API log line → queued job. Correlating those by
  // timestamp instead is guesswork under any real traffic.
  const inbound = await headers();
  const requestId = inbound.get("x-request-id");
  if (requestId !== null) {
    result["x-request-id"] = requestId;
  }

  return result;
}
