/**
 * The ONE sealed-session implementation, shared by every `scope:web` app.
 *
 * It lives in a lib rather than in an app because BOTH Next apps now hold a
 * session: the dashboard has since the beginning, and the storefront gained one
 * when it grew a sign-in control. Two copies of an AES-GCM sealing routine is
 * two things to keep in step, and the failure mode of drift here is a cookie
 * that decrypts in one app and silently does not in the other.
 *
 * Only the PORTABLE half lives here — the crypto and the payload contract, both
 * of which take the secret as a parameter. Cookie names, attributes and CSRF
 * remain app-local, because those are deployment concerns that legitimately
 * differ between the store and the dashboard.
 */
export { seal, unseal } from "./seal";
export {
  acknowledgementSchema,
  apiLoginSuccessSchema,
  authTokensSchema,
  loginResultSchema,
  refreshResponseSchema,
  sessionListSchema,
  twoFactorRequiredSchema,
  type Acknowledgement,
  type AuthTokens,
  type LoginResult,
} from "./api-auth";
export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./constants";
export { createCsrfToken, timingSafeEqual, verifyCsrf } from "./csrf";
export {
  clearedCookieAttributes,
  csrfCookieAttributes,
  secondsUntil,
  sessionCookieAttributes,
  type CookieAttributes,
  type CookieScope,
} from "./cookies";
export {
  applyRefreshedTokens,
  decodeSession,
  encodeSession,
  isAccessTokenExpired,
  isPrivileged,
  isSessionExpired,
  sessionPayloadSchema,
  type SessionPayload,
} from "./session";
