import { z } from "zod";
import {
  customerSchema,
  type Customer,
  type Locale,
} from "@akai/contracts";
import { apiRequest, type ApiRequestOptions } from "./http";
import type { ApiResult } from "./errors";
import {
  acknowledgementSchema,
  authTokensSchema,
  loginResultSchema,
  refreshResponseSchema,
  sessionListSchema,
  type Acknowledgement,
  type AuthTokens,
  type LoginResult,
} from "@akai/session";

/**
 * Typed wrappers over the API's auth surface
 * (`apps/api/src/modules/auth/auth.controller.ts`).
 *
 * One function per endpoint, each pinning its own response schema. Request
 * bodies are typed from @akai/contracts where the shared lib carries them, so
 * a field renamed in the contract breaks compilation here rather than 400ing at
 * runtime.
 *
 * All of these take `baseUrl` explicitly rather than reading the environment.
 * That keeps the module pure and testable with a stub `fetch`, and it is what
 * lets middleware (which has its own env access) call `refresh` directly.
 */

interface AuthCall {
  readonly baseUrl: string;
  readonly requestId?: string;
}

/** Shared option assembly. `requestId` is threaded so one id spans the whole flow. */
function call<T>(
  context: AuthCall,
  options: Omit<ApiRequestOptions<T>, "baseUrl" | "requestId">,
): Promise<ApiResult<T>> {
  return apiRequest<T>({
    baseUrl: context.baseUrl,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Registration and verification
// ---------------------------------------------------------------------------

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly preferredLocale: Locale;
  readonly turnstileToken: string;
  readonly marketingConsent: boolean;
}

/** 202 + neutral acknowledgement whether or not the address was already taken. */
export function register(
  context: AuthCall,
  input: RegisterInput,
): Promise<ApiResult<Acknowledgement>> {
  return call(context, {
    method: "POST",
    path: "/auth/register",
    body: input,
    schema: acknowledgementSchema,
  });
}

export function verifyEmail(
  context: AuthCall,
  token: string,
): Promise<ApiResult<Acknowledgement>> {
  return call(context, {
    method: "POST",
    path: "/auth/verify-email",
    body: { token },
    schema: acknowledgementSchema,
  });
}

export function resendVerification(
  context: AuthCall,
  input: { readonly email: string; readonly turnstileToken: string },
): Promise<ApiResult<Acknowledgement>> {
  return call(context, {
    method: "POST",
    path: "/auth/resend-verification",
    body: input,
    schema: acknowledgementSchema,
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * The explicit `| undefined` on the optional members is required by
 * `exactOptionalPropertyTypes`, not sloppiness. zod's `.optional()` produces
 * `totpCode?: string | undefined` — the key may be present AND hold undefined —
 * so a caller passing a parsed body would otherwise be rejected. The `body`
 * assembly in `login()` still omits the key entirely rather than sending
 * `undefined`, which is what the API's `.strict()` schema requires.
 */
export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /** Second leg of a 2FA login. */
  readonly totpCode?: string | undefined;
  /** Alternative second leg for a lost authenticator. */
  readonly recoveryCode?: string | undefined;
}

/**
 * Returns either a token pair or `requiresTwoFactor: true`.
 *
 * The token pair is for THIS process to hold. It must never be written into a
 * response body that reaches the browser — the only thing that crosses that
 * boundary is the sealed cookie.
 */
export function login(context: AuthCall, input: LoginInput): Promise<ApiResult<LoginResult>> {
  return call(context, {
    method: "POST",
    path: "/auth/login",
    // Assembled key by key rather than spread: the API's login schema is
    // .strict(), so an `undefined` totpCode surviving into the JSON would be
    // rejected outright under exactOptionalPropertyTypes semantics.
    body: {
      email: input.email,
      password: input.password,
      ...(input.totpCode === undefined ? {} : { totpCode: input.totpCode }),
      ...(input.recoveryCode === undefined ? {} : { recoveryCode: input.recoveryCode }),
    },
    schema: loginResultSchema,
  });
}

/**
 * Rotates a refresh token.
 *
 * SINGLE USE. Presenting a token that has already been consumed is treated by
 * the API as a replay and revokes the entire token family, signing the user out
 * everywhere. That is why this is never called speculatively or concurrently —
 * see the serialisation note in `middleware.ts`.
 */
export function refresh(
  context: AuthCall,
  refreshToken: string,
): Promise<ApiResult<{ tokens: AuthTokens }>> {
  return call(context, {
    method: "POST",
    path: "/auth/refresh",
    body: { refreshToken },
    schema: refreshResponseSchema,
  });
}

export function logout(
  context: AuthCall,
  accessToken: string,
  options: { readonly refreshToken?: string; readonly allDevices: boolean },
): Promise<ApiResult<Acknowledgement>> {
  return call(context, {
    method: "POST",
    path: "/auth/logout",
    accessToken,
    body: {
      allDevices: options.allDevices,
      ...(options.refreshToken === undefined ? {} : { refreshToken: options.refreshToken }),
    },
    schema: acknowledgementSchema,
  });
}

/**
 * The signed-in customer, AS THE API SEES THEM RIGHT NOW.
 *
 * This is the authoritative role check. The role cached in the session cookie
 * is advisory (see session.ts); `(admin)/layout.tsx` calls this instead,
 * so a role revoked one second ago is enforced on the next page view rather
 * than when the access token happens to expire.
 */
export function me(context: AuthCall, accessToken: string): Promise<ApiResult<Customer>> {
  return call(context, {
    method: "GET",
    path: "/auth/me",
    accessToken,
    schema: customerSchema,
  });
}

export function listSessions(
  context: AuthCall,
  accessToken: string,
): Promise<ApiResult<z.infer<typeof sessionListSchema>>> {
  return call(context, {
    method: "GET",
    path: "/auth/sessions",
    accessToken,
    schema: sessionListSchema,
  });
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export function requestPasswordReset(
  context: AuthCall,
  input: { readonly email: string; readonly turnstileToken: string },
): Promise<ApiResult<Acknowledgement>> {
  return call(context, {
    method: "POST",
    path: "/auth/password-reset/request",
    body: input,
    schema: acknowledgementSchema,
  });
}

export function confirmPasswordReset(
  context: AuthCall,
  input: { readonly token: string; readonly password: string },
): Promise<ApiResult<Acknowledgement>> {
  return call(context, {
    method: "POST",
    path: "/auth/password-reset/confirm",
    body: input,
    schema: acknowledgementSchema,
  });
}

export function changePassword(
  context: AuthCall,
  accessToken: string,
  input: { readonly currentPassword: string; readonly newPassword: string },
): Promise<ApiResult<Acknowledgement>> {
  return call(context, {
    method: "POST",
    path: "/auth/password/change",
    accessToken,
    body: input,
    schema: acknowledgementSchema,
  });
}

export { authTokensSchema };
