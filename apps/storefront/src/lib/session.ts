import { decodeSession, isSessionExpired, type SessionPayload } from "@akai/session";
import type { AstroCookies } from "astro";

import { serverEnv } from "./env";

/**
 * Reads the session the DASHBOARD writes. The storefront never signs anyone in
 * or holds tokens of its own: sign-in, sign-up and the account live on the
 * dashboard, and the shared sealed cookie makes that one sign-in for both.
 */
export async function readSession(cookies: AstroCookies): Promise<SessionPayload | null> {
  const env = serverEnv();
  const session = await decodeSession(cookies.get(env.SESSION_COOKIE_NAME)?.value, env.SESSION_SECRET);
  return session === null || isSessionExpired(session) ? null : session;
}
