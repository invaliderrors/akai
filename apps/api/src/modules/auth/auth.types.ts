import type { Role } from "@akai/contracts";

/**
 * The auth module's own view of the data it touches.
 *
 * These are deliberately NOT the Prisma model types. The service depends on
 * this narrow vocabulary and on `AuthRepository`, so its logic is unit-testable
 * against an in-memory repository with no database, no testcontainer and no
 * mocking framework. The Prisma-shaped translation lives in exactly one file
 * (prisma-auth.repository.ts) and is covered by apps/api-e2e.
 *
 * Nothing here leaves the module: the controller serialises through the
 * `customerSchema` in @akai/contracts, which has no password, secret or token
 * field, so a careless `res.json(customer)` cannot leak credential material.
 */

/** Purposes for the single-use, hashed-at-rest AuthToken table. */
export const AUTH_TOKEN_PURPOSES = ["EMAIL_VERIFICATION", "PASSWORD_RESET"] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * A customer as the auth module sees them — credential material included.
 *
 * This shape must never be returned from a controller. `AuthService` maps it to
 * the contracts' `Customer` via `toPublicCustomer` before anything is
 * serialised.
 */
export interface AuthCustomer {
  readonly id: string;
  readonly email: string;
  /** Null for a guest-checkout shell record that has never set a password. */
  readonly passwordHash: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly role: Role;
  /** AES-256-GCM sealed. Never the raw base32 secret. */
  readonly totpSecret: string | null;
  readonly totpEnabledAt: Date | null;
  readonly anonymisedAt: Date | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly marketingConsentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SessionRecord {
  readonly id: string;
  readonly customerId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly twoFactorAssertedAt: Date | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface RefreshTokenRecord {
  readonly id: string;
  readonly customerId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface AuthTokenRecord {
  readonly id: string;
  readonly customerId: string;
  readonly purpose: AuthTokenPurpose;
  readonly tokenHash: string;
  readonly usedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/**
 * A live emailed sign-in code.
 *
 * The customer id is the PRIMARY KEY, so one live code per customer is a
 * database guarantee rather than an application "invalidate the old one first"
 * that two concurrent requests can interleave with. `codeHash` is SHA-256 over
 * `${customerId}:${code}` — customer-BOUND, which is what makes a six-digit
 * secret storable at all: the bare digest of a code drawn from 10^6 values
 * collides across customers, and a lookup by hash alone would let a code issued
 * to one account authenticate another.
 */
export interface EmailOtpRecord {
  readonly customerId: string;
  readonly codeHash: string;
  /** Guesses spent against THIS issuance. The verifier burns the code at the cap. */
  readonly attempts: number;
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/**
 * The principal attached to an authenticated request.
 *
 * `role` here is ALWAYS the value read from the database on this request, never
 * the `role` claim carried in the JWT (spec §8). The claim exists only so logs
 * and metrics can be labelled without a query; authorisation decisions read
 * this field, which is why revoking an admin takes effect on the very next
 * request rather than 15 minutes later when the access token expires.
 */
export interface AuthenticatedUser {
  readonly customerId: string;
  readonly sessionId: string;
  readonly role: Role;
  readonly email: string;
  readonly emailVerified: boolean;
  /**
   * When this session last proved possession of a TOTP code. Admin routes
   * require this to be recent (see TwoFactorFreshnessGuard).
   */
  readonly twoFactorAssertedAt: Date | null;
}

/** Request-scoped context every credential-touching operation is audited with. */
export interface RequestContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * The only logging surface AuthService uses.
 *
 * Narrower than pino's `Logger` on purpose. pino's interface is large and its
 * log methods are overloaded, so a test double would have to be a cast to
 * satisfy it — and casts are exactly what this codebase forbids. Declared with
 * METHOD syntax so parameter bivariance lets the real pino logger satisfy it
 * structurally: the module binding still injects the configured, PII-redacting
 * logger, and a test can pass a four-line object.
 */
export interface AuthLogger {
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/**
 * The token pair handed to the dashboard's BFF route handlers.
 *
 * IMPORTANT (spec §8): this crosses API -> BFF only. The BFF holds both values
 * server-side and sets a single httpOnly `akai_session` cookie; neither token
 * is ever forwarded to the browser, which is why the browser-facing
 * `loginResponseSchema` in @akai/contracts deliberately has no token field.
 */
export interface TokenPair {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
}
