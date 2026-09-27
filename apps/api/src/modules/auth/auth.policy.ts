import { createHash } from "node:crypto";

/**
 * Tunable security policy for the auth module.
 *
 * Injected rather than hard-coded so tests can assert the BOUNDARY (the 5th
 * failure locks, the 4th does not) in milliseconds instead of by burning real
 * time, and so an operator can tighten a window without a code change.
 */
export interface AuthPolicy {
  /** Consecutive failures before the durable lockout arms. */
  readonly maxFailedLogins: number;
  readonly lockoutMs: number;
  readonly emailVerificationTtlMs: number;
  /**
   * Short by design. A reset link sits in a mailbox, and mailboxes get
   * forwarded, backed up and shoulder-surfed; a 24-hour reset window is a
   * 24-hour account-takeover window.
   */
  readonly passwordResetTtlMs: number;
  readonly sessionTtlMs: number;
  /** How recently an admin session must have proved a second factor. */
  readonly twoFactorFreshnessMs: number;
  /**
   * Minimum interval between `session.lastSeenAt` writes. Without this every
   * authenticated request issues an UPDATE, turning the session table into the
   * hottest write target in the database for no operational gain.
   */
  readonly sessionTouchIntervalMs: number;
  readonly recoveryCodeCount: number;
  /**
   * Life of an emailed sign-in code. Short by the same argument as the reset
   * link, and shorter still: the code is only six digits, so its window IS its
   * strength. Ten minutes is long enough for a mail to arrive and be typed.
   */
  readonly loginCodeTtlMs: number;
  /**
   * Guesses allowed against ONE issued code before it is burnt.
   *
   * The cap is per ISSUANCE, not per source address, which is the only version
   * that bounds anything: an attacker walking 10^6 codes from rotating IPs
   * defeats an address-keyed budget and cannot defeat this one. Five guesses
   * out of a million leaves a 1-in-200,000 chance per issuance.
   */
  readonly loginCodeMaxAttempts: number;
}

export const AUTH_POLICY = Symbol("AUTH_POLICY");

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  maxFailedLogins: 10,
  lockoutMs: 15 * 60 * 1000,
  emailVerificationTtlMs: 24 * 60 * 60 * 1000,
  passwordResetTtlMs: 60 * 60 * 1000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  twoFactorFreshnessMs: 15 * 60 * 1000,
  sessionTouchIntervalMs: 60 * 1000,
  recoveryCodeCount: 10,
  loginCodeTtlMs: 10 * 60 * 1000,
  loginCodeMaxAttempts: 5,
};

/**
 * Rate-limit budgets per endpoint.
 *
 * The KEY is chosen by the layer that enforces the budget, not by the budget
 * itself, and there is only one enforcement layer that works here:
 *
 *  - `AuthRateLimitGuard` keys on the socket address and is installed NOWHERE.
 *    Express `trust proxy` is deliberately unset (see rate-limit.guard.ts), and
 *    every customer reaches this API through the Next BFF route handlers — so
 *    the socket address is the STOREFRONT/DASHBOARD CONTAINER's for all of
 *    them. Installing it collapses the entire user base into one bucket, where
 *    a spent `refresh` budget signs everyone out and a spent `login` budget
 *    stops them signing back in. A global auth lockout is strictly worse than
 *    no limit. It was installed once and reverted; do not reinstate it.
 *  - `AuthService` keys on the EMAIL in the request body (`emailRateLimitKey`
 *    below), which is per-account and therefore cannot lock the platform out.
 *    This is the live one.
 */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * `satisfies` rather than a `Record<string, RateLimitRule>` annotation: the
 * annotation would widen the keys to `string`, and under
 * `noUncheckedIndexedAccess` every lookup would then be `RateLimitRule |
 * undefined`, forcing a meaningless fallback at each of the eight call sites.
 * This way the keys stay literal and `AUTH_RATE_LIMITS.login` is total.
 */
export const AUTH_RATE_LIMITS = {
  // Tight: this is the credential-stuffing surface.
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
  register: { limit: 5, windowMs: 60 * 60 * 1000 },
  // Also an email-bomb surface, not just an auth one.
  passwordResetRequest: { limit: 5, windowMs: 60 * 60 * 1000 },
  passwordResetConfirm: { limit: 10, windowMs: 60 * 60 * 1000 },
  verifyEmail: { limit: 10, windowMs: 60 * 60 * 1000 },
  resendVerification: { limit: 3, windowMs: 60 * 60 * 1000 },
  // Higher: a legitimate SPA refreshes often, and a stolen refresh token is
  // caught by reuse detection rather than by throttling.
  refresh: { limit: 60, windowMs: 15 * 60 * 1000 },
  // 6 digits is 10^6; this budget makes online brute force hopeless.
  totp: { limit: 10, windowMs: 15 * 60 * 1000 },
  // An emailed code is mail sent to an address the CALLER names, so this is an
  // email-bomb surface before it is an auth one — same budget as the reset link.
  loginCodeRequest: { limit: 5, windowMs: 60 * 60 * 1000 },
  // Deliberately NOT the only bound on guessing: the per-issuance attempt cap in
  // `loginCodeMaxAttempts` is what survives an attacker rotating source
  // addresses, because this budget is keyed on the address in the body. This one
  // stops a single caller hammering one account.
  loginCodeVerify: { limit: 10, windowMs: 15 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export type AuthRateLimitBucket = keyof typeof AUTH_RATE_LIMITS;

/**
 * `rate_limit_counter.key` is `VarChar(200)`. An address long enough to
 * overflow it would make the INSERT throw, and the limiter fails open on a
 * store error — so an unbounded key is a rate-limit BYPASS available to anyone
 * who registers a 200-character address, not a cosmetic concern.
 */
const RATE_LIMIT_KEY_MAX_LENGTH = 200;

/**
 * Fold an address onto the ONE bucket the database would treat it as.
 *
 * `customer.email` is `citext`, so `Ana@X.eu` and `ana@x.eu` are the same
 * account; keying them separately would hand an attacker a fresh budget per
 * capitalisation. Padding is trimmed for the same reason. Nothing beyond that
 * is folded: a homoglyph address is a genuinely different account, and merging
 * it would throttle an innocent third party.
 */
export function normaliseRateLimitEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The limiter key for an email-keyed budget — the shape `RateLimitCounter`'s
 * own docstring names (`"login:email:a@b.com"`), kept readable so an operator
 * can find a throttled account in the table.
 *
 * Over-long addresses fall back to a digest of the SAME normalised value, so
 * the bucket is still stable and still one-per-address; only its legibility is
 * spent. The prefix stays in the clear so the endpoint remains greppable.
 */
export function emailRateLimitKey(bucket: AuthRateLimitBucket, email: string): string {
  const prefix = `${bucket}:email:`;
  const normalised = normaliseRateLimitEmail(email);
  const key = `${prefix}${normalised}`;

  if (key.length <= RATE_LIMIT_KEY_MAX_LENGTH) {
    return key;
  }

  return `${prefix}sha256:${createHash("sha256").update(normalised).digest("hex")}`;
}
