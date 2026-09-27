import { z } from "zod";
import { customerSchema, idSchema, isoDateTimeSchema } from "@akai/contracts";

/**
 * The API→BFF auth shapes.
 *
 * @akai/contracts carries the BROWSER-facing `loginResponseSchema`, which
 * correctly has no tokens in it. These are the other side of the BFF: the
 * API/BFF shapes that DO carry tokens, mirroring
 * `apps/api/src/modules/auth/dto/auth.dto.ts`.
 *
 * ---------------------------------------------------------------------------
 * KNOWN DUPLICATION — read before editing.
 *
 * These schemas are declared twice in the repo: here and in the API's DTO
 * module. That is exactly the drift libs/contracts exists to prevent, and it is
 * temporary. It is NOT fixed by importing across apps — `apps/dashboard`
 * importing `apps/api` is an Nx boundary violation (scope:web may depend only
 * on scope:shared) and would drag @nestjs/* into a browser build.
 *
 * The fix is to PROMOTE `authTokensSchema` and the login-result union into
 * libs/contracts and have both sides import them. That edit touches a shared
 * lib owned by the foundation pass, so it is listed in followUps rather than
 * made here while other agents are working in the same tree.
 *
 * Until then, `api-auth` is pinned by tests that every field name and type against the
 * API's declaration, so a divergence fails a test instead of failing a login.
 * ---------------------------------------------------------------------------
 */

export const authTokensSchema = z
  .object({
    accessToken: z.string().min(1),
    accessTokenExpiresAt: isoDateTimeSchema,
    refreshToken: z.string().min(1),
    refreshTokenExpiresAt: isoDateTimeSchema,
    sessionId: idSchema,
  })
  .strict();

export type AuthTokens = z.infer<typeof authTokensSchema>;

/** Successful login: a session now exists and the token pair is live. */
export const apiLoginSuccessSchema = z
  .object({
    customer: customerSchema,
    requiresTwoFactor: z.literal(false),
    tokens: authTokensSchema,
  })
  .strict();

/**
 * First leg of a 2FA login.
 *
 * No customer object and no tokens: the password alone must not reveal the
 * account holder's name, and no session exists until the second factor lands.
 */
export const twoFactorRequiredSchema = z
  .object({
    requiresTwoFactor: z.literal(true),
  })
  .strict();

/**
 * Discriminating on the `requiresTwoFactor` LITERAL rather than on the presence
 * of `tokens` is what makes `result.tokens` a compile error on the 2FA branch.
 */
export const loginResultSchema = z.union([apiLoginSuccessSchema, twoFactorRequiredSchema]);
export type LoginResult = z.infer<typeof loginResultSchema>;

export const refreshResponseSchema = z.object({ tokens: authTokensSchema }).strict();

/**
 * The single neutral acknowledgement shared by register, resend-verification
 * and password-reset-request.
 *
 * All three return this identical body whether or not the address exists. The
 * UI must render an identical message for it — branching on anything here would
 * rebuild the account-existence oracle the API went out of its way to remove.
 */
export const acknowledgementSchema = z.object({ status: z.literal("accepted") }).strict();
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

/** `GET /auth/sessions` — the security page's device list. */
export const sessionListSchema = z.array(
  z
    .object({
      id: idSchema,
      createdAt: isoDateTimeSchema,
      lastSeenAt: isoDateTimeSchema,
      expiresAt: isoDateTimeSchema,
      ipAddress: z.string().nullable(),
      userAgent: z.string().nullable(),
      isCurrent: z.boolean(),
    })
    .strict(),
);
