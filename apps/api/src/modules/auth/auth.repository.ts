import type { Locale, Role } from "@akai/contracts";
import type {
  AuthCustomer,
  AuthTokenPurpose,
  AuthTokenRecord,
  EmailOtpRecord,
  RefreshTokenRecord,
  SessionRecord,
} from "./auth.types";

/**
 * The persistence port for the auth module.
 *
 * Two reasons this exists rather than AuthService talking to Prisma directly:
 *
 * 1. Every security rule in this module (lockout, reuse detection, single-use
 *    tokens, enumeration resistance) becomes unit-testable against an in-memory
 *    implementation. Those rules are the ones that must never regress, and
 *    tests that need a live Postgres are tests that get skipped.
 *
 * 2. The two CONDITIONAL writes below are the module's real concurrency
 *    guarantees, and stating them as a boolean-returning contract forces every
 *    implementation to honour them.
 *
 * The Prisma implementation is thin by design; it is exercised end-to-end in
 * apps/api-e2e against a real database.
 */
export interface AuthRepository {
  // --- customers -----------------------------------------------------------

  findCustomerByEmail(email: string): Promise<AuthCustomer | null>;
  findCustomerById(id: string): Promise<AuthCustomer | null>;

  createCustomer(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly preferredLocale: Locale;
    readonly marketingConsentAt: Date | null;
  }): Promise<AuthCustomer>;

  updatePasswordHash(customerId: string, passwordHash: string): Promise<void>;

  /** Bumps the durable failure counter and optionally arms the lockout. */
  recordFailedLogin(customerId: string, lockedUntil: Date | null): Promise<void>;

  clearFailedLogins(customerId: string): Promise<void>;

  markEmailVerified(customerId: string, verifiedAt: Date): Promise<void>;

  setTotpSecret(
    customerId: string,
    sealedSecret: string | null,
    enabledAt: Date | null,
  ): Promise<void>;

  // --- sessions ------------------------------------------------------------

  createSession(input: {
    readonly customerId: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly expiresAt: Date;
    readonly twoFactorAssertedAt: Date | null;
  }): Promise<SessionRecord>;

  findSessionById(id: string): Promise<SessionRecord | null>;
  listActiveSessions(customerId: string, now: Date): Promise<readonly SessionRecord[]>;
  touchSession(id: string, lastSeenAt: Date): Promise<void>;
  revokeSession(id: string, revokedAt: Date): Promise<void>;

  /**
   * Global logout. `exceptSessionId` supports "change password, keep me signed
   * in here" — the current session survives, every other device is evicted.
   */
  revokeAllSessions(
    customerId: string,
    revokedAt: Date,
    exceptSessionId: string | null,
  ): Promise<void>;

  markTwoFactorAsserted(sessionId: string, assertedAt: Date): Promise<void>;

  // --- refresh tokens ------------------------------------------------------

  createRefreshToken(input: {
    readonly customerId: string;
    readonly sessionId: string;
    readonly familyId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<RefreshTokenRecord>;

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;

  /**
   * CONDITIONAL write. Must be a single statement equivalent to
   * `UPDATE ... SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL`,
   * returning whether a row was affected.
   *
   * Returning false means someone already consumed this token — either a replay
   * or two tabs racing. Read-then-write here would let both callers observe
   * `consumedAt: null` and both succeed, which silently defeats the entire
   * reuse-detection scheme.
   */
  consumeRefreshToken(id: string, consumedAt: Date): Promise<boolean>;

  /** Reuse detection response: kill every token descended from one login. */
  revokeRefreshTokenFamily(familyId: string, revokedAt: Date): Promise<void>;

  revokeAllRefreshTokens(customerId: string, revokedAt: Date): Promise<void>;

  // --- email verification / password reset ---------------------------------

  createAuthToken(input: {
    readonly customerId: string;
    readonly purpose: AuthTokenPurpose;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AuthTokenRecord>;

  findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRecord | null>;

  /**
   * CONDITIONAL write, same rule as `consumeRefreshToken`: single-use means
   * single-use under concurrency, not "we checked `usedAt` a moment ago".
   */
  consumeAuthToken(id: string, usedAt: Date): Promise<boolean>;

  /** Invalidate outstanding tokens of a purpose — e.g. after a completed reset. */
  invalidateAuthTokens(
    customerId: string,
    purpose: AuthTokenPurpose,
    usedAt: Date,
  ): Promise<void>;

  // --- TOTP recovery codes -------------------------------------------------

  replaceRecoveryCodes(customerId: string, codeHashes: readonly string[]): Promise<void>;

  /**
   * CONDITIONAL write. True only if this code existed, belonged to this
   * customer and was previously unused.
   */
  consumeRecoveryCode(
    customerId: string,
    codeHash: string,
    usedAt: Date,
  ): Promise<boolean>;

  countUnusedRecoveryCodes(customerId: string): Promise<number>;

  // --- emailed one-time sign-in codes --------------------------------------

  /**
   * Issue a code, REPLACING any live one.
   *
   * An UPSERT keyed on the customer, never an insert: `email_otp` has the
   * customer id as its primary key precisely so "one live code per customer" is
   * enforced by the key. A delete-then-insert pair would race with a concurrent
   * request and could leave two valid codes, or none.
   */
  upsertEmailOtp(input: {
    readonly customerId: string;
    readonly codeHash: string;
    readonly expiresAt: Date;
  }): Promise<EmailOtpRecord>;

  /**
   * Look the code up BY CUSTOMER, never by hash.
   *
   * `findAuthTokenByHash` is the wrong shape for a short secret: a hash-only
   * lookup over a 10^6 space authenticates whichever row happens to match. The
   * digest is customer-bound and so is this read.
   */
  findEmailOtp(customerId: string): Promise<EmailOtpRecord | null>;

  /**
   * CONDITIONAL write, same rule as `consumeRefreshToken`. Must be a single
   * statement equivalent to `UPDATE ... SET "consumedAt" = $1 WHERE
   * "customerId" = $2 AND "codeHash" = $3 AND "consumedAt" IS NULL AND
   * "expiresAt" > $1`, returning whether a row was affected. Two tabs
   * submitting the same code must not both obtain a session.
   */
  consumeEmailOtp(
    customerId: string,
    codeHash: string,
    consumedAt: Date,
  ): Promise<boolean>;

  /**
   * Atomic increment. Returns the NEW attempt count, or null when no live code
   * row exists (a concurrent burn won).
   *
   * `increment`, not read-modify-write: parallel guesses must each count, and a
   * lost update here raises the effective cap under exactly the conditions the
   * cap exists to bound.
   */
  recordEmailOtpAttempt(customerId: string): Promise<number | null>;

  /** Burn the code outright. Idempotent. */
  deleteEmailOtp(customerId: string): Promise<void>;
}

export const AUTH_REPOSITORY = Symbol("AUTH_REPOSITORY");

/** Narrow projection used when an admin/staff role must be re-read per request. */
export interface SessionPrincipal {
  readonly session: SessionRecord;
  readonly customerId: string;
  readonly email: string;
  readonly role: Role;
  readonly emailVerifiedAt: Date | null;
  readonly anonymisedAt: Date | null;
}
