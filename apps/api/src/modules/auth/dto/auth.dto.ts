import { z } from "zod";
import {
  changePasswordSchema,
  confirmPasswordResetSchema,
  customerSchema,
  emailSchema,
  loginRequestSchema,
  passwordSchema,
  registerRequestSchema,
  requestLoginCodeSchema,
  requestPasswordResetSchema,
  verifyEmailSchema,
  verifyLoginCodeSchema,
} from "@akai/contracts";

/**
 * Request/response schemas for the auth surface.
 *
 * Shapes that already exist in @akai/contracts are RE-EXPORTED, never
 * redeclared — a second declaration of `registerRequestSchema` here would be
 * exactly the drift the contracts lib exists to prevent. Only shapes the shared
 * lib does not yet carry are defined locally, and each is listed in followUps
 * for promotion into libs/contracts by the integration agent.
 *
 * Every request schema is `.strict()`, which is the `forbidNonWhitelisted`
 * behaviour spec §7 requires: an unknown key is REJECTED, not stripped, so a
 * client cannot smuggle `role: "ADMIN"` into a registration payload and have it
 * survive into a Prisma `data:` spread.
 */

export {
  changePasswordSchema,
  confirmPasswordResetSchema,
  registerRequestSchema,
  requestLoginCodeSchema,
  requestPasswordResetSchema,
  verifyEmailSchema,
  verifyLoginCodeSchema,
};

export type RequestLoginCodeBody = z.infer<typeof requestLoginCodeSchema>;

/**
 * Verifying an emailed code.
 *
 * NOTE what this deliberately does NOT extend, unlike `loginBodySchema`: there
 * is no `recoveryCode`. A recovery code is the lost-device path and it already
 * has one home, `POST /auth/login`; accepting it here too would add a second
 * branch to a credential endpoint for no capability the customer does not
 * already have. One second-factor input on this route, or none.
 */
export type VerifyLoginCodeBody = z.infer<typeof verifyLoginCodeSchema>;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Extends the shared login schema with a recovery-code path.
 *
 * A user who has lost their authenticator device but holds a printed recovery
 * code must be able to complete the second factor; without this the only route
 * back into an ADMIN account (where 2FA is mandatory) is a manual database
 * edit.
 */
export const loginBodySchema = loginRequestSchema
  .extend({
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .strict();

export type LoginBody = z.infer<typeof loginBodySchema>;

/**
 * The API's login response.
 *
 * NOTE the deliberate difference from `loginResponseSchema` in @akai/contracts:
 * that schema is the BROWSER-facing shape and correctly carries no tokens. This
 * one is the API -> BFF shape. Spec §8 has the dashboard's route handlers hold
 * both tokens server-side and set a single httpOnly cookie, so the tokens must
 * reach the BFF somehow — but they stop there. The two schemas are separate
 * types precisely so "which side of the BFF am I on" is answered by the type
 * system rather than by a comment.
 */
export const authTokensSchema = z
  .object({
    accessToken: z.string().min(1),
    accessTokenExpiresAt: z.string().datetime({ offset: true }),
    refreshToken: z.string().min(1),
    refreshTokenExpiresAt: z.string().datetime({ offset: true }),
    sessionId: z.string().uuid(),
  })
  .strict();

export type AuthTokens = z.infer<typeof authTokensSchema>;

export const apiLoginResponseSchema = z
  .object({
    customer: customerSchema,
    requiresTwoFactor: z.literal(false),
    tokens: authTokensSchema,
  })
  .strict();

/**
 * First leg of a 2FA login: credentials were correct, but no session exists yet
 * and no tokens are issued. Carrying no customer object is intentional — the
 * password alone must not reveal the account holder's name.
 */
export const twoFactorRequiredResponseSchema = z
  .object({
    requiresTwoFactor: z.literal(true),
  })
  .strict();

export const loginResultSchema = z.union([
  apiLoginResponseSchema,
  twoFactorRequiredResponseSchema,
]);

export type LoginResult = z.infer<typeof loginResultSchema>;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export const refreshBodySchema = z
  .object({
    refreshToken: z.string().min(1).max(512),
  })
  .strict();

export type RefreshBody = z.infer<typeof refreshBodySchema>;

export const refreshResponseSchema = z.object({ tokens: authTokensSchema }).strict();

export const logoutBodySchema = z
  .object({
    refreshToken: z.string().min(1).max(512).optional(),
    /** Log out every device, not just this one. */
    allDevices: z.boolean().default(false),
  })
  .strict();

export type LogoutBody = z.infer<typeof logoutBodySchema>;

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export const resendVerificationSchema = z
  .object({
    email: emailSchema,
    turnstileToken: z.string().min(1),
  })
  .strict();

export type ResendVerificationBody = z.infer<typeof resendVerificationSchema>;

/**
 * The single neutral response shared by register, password-reset request and
 * verification resend.
 *
 * All three return this identical body with a 200/202 regardless of whether the
 * address exists. That uniformity IS the anti-enumeration control — the moment
 * one branch returns a different shape, status or field, the endpoint becomes
 * an account oracle.
 */
export const acknowledgementSchema = z
  .object({
    status: z.literal("accepted"),
  })
  .strict();

export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

export const ACKNOWLEDGEMENT: Acknowledgement = { status: "accepted" };

// ---------------------------------------------------------------------------
// Two-factor enrolment
// ---------------------------------------------------------------------------

/** Step 1: returns a secret + QR URI. 2FA is NOT active until confirmed. */
export const totpEnrolmentSchema = z
  .object({
    secret: z.string().min(1),
    keyUri: z.string().min(1),
  })
  .strict();

export const confirmTotpSchema = z
  .object({
    secret: z.string().min(1).max(128),
    code: z.string().length(6),
  })
  .strict();

export type ConfirmTotpBody = z.infer<typeof confirmTotpSchema>;

/**
 * Recovery codes are returned EXACTLY ONCE, at enrolment. They are stored
 * SHA-256-hashed, so there is no endpoint that can show them again — only
 * regeneration, which invalidates the previous set.
 */
export const recoveryCodesSchema = z
  .object({
    recoveryCodes: z.array(z.string()).length(10),
  })
  .strict();

/** Disabling 2FA re-authenticates with the password: possession is not enough. */
export const disableTotpSchema = z
  .object({
    password: z.string().min(1),
  })
  .strict();

export type DisableTotpBody = z.infer<typeof disableTotpSchema>;

// Re-exported so callers need one import for the whole auth vocabulary.
export { customerSchema, emailSchema, passwordSchema };
