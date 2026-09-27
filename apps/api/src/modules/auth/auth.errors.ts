import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from "@nestjs/common";
import type { AuthFailureReason } from "@akai/contracts";

/**
 * The auth module's exception vocabulary.
 *
 * These are FACTORIES rather than inline `throw new UnauthorizedException(...)`
 * for one reason: user enumeration is prevented by every credential failure
 * being indistinguishable, and that only holds if there is a single place the
 * message is written. Inline construction is how "Invalid password" ends up
 * next to "No account with that email" six months later, at which point the
 * login endpoint is an account oracle.
 *
 * Every distinguishable failure below is deliberately NOT distinguishable to
 * the client: wrong password, unknown email, locked account, unverified
 * mailbox, anonymised record and a failed second factor all produce the exact
 * same 401 body. The real reason is logged server-side.
 */

/** The ONE credential-failure response. Used by every path in the login flow. */
export function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException("Invalid email or password");
}

/**
 * Used for refresh, verification and reset tokens alike. Does not distinguish
 * expired from consumed from never-existed — each distinction is a probe an
 * attacker can use to confirm a token was real.
 */
export function invalidToken(): UnauthorizedException {
  return new UnauthorizedException("Invalid or expired token");
}

export function notAuthenticated(): UnauthorizedException {
  return new UnauthorizedException("Authentication required");
}

export function insufficientRole(): ForbiddenException {
  return new ForbiddenException("Insufficient permissions");
}

/**
 * Admin surface reached by a session that has not recently proved a second
 * factor. Distinct from `insufficientRole` because the CLIENT MUST act on it —
 * the dashboard needs to prompt for a TOTP code rather than showing "access
 * denied" to a legitimate admin.
 */
export function twoFactorRequired(): ForbiddenException {
  return forbiddenWithReason("TWO_FACTOR_REQUIRED", "Two-factor authentication required");
}

/**
 * A FORBIDDEN that carries a machine-readable sub-code.
 *
 * `FORBIDDEN` is shared by "wrong role" and both two-factor cases, and only one
 * of those is something the operator can fix. The sub-code is what lets the
 * dashboard offer "sign in again" instead of a dead end — the client parses it
 * against `authFailureReasonSchema` and never renders it. The global exception
 * filter reads `reason` off this payload and emits it on the error envelope.
 */
function forbiddenWithReason(
  reason: AuthFailureReason,
  message: string,
): ForbiddenException {
  return new ForbiddenException({ code: "FORBIDDEN", reason, message });
}

/**
 * A privileged account (ADMIN) authenticated its password but has never enrolled
 * a second factor. Spec §8 makes TOTP MANDATORY for ADMIN, so a password-only
 * admin session must never be issued — that is exactly the escalation surface
 * two-factor exists to close. Distinct from `twoFactorRequired` because there is
 * no code to prompt for yet: the account must complete enrolment (out of band /
 * via provisioning) before it can sign in at all.
 *
 * This message is only ever reached AFTER a correct password, so the role it
 * implies is disclosed solely to a caller who already holds that account's
 * credentials — no new enumeration surface.
 */
export function twoFactorEnrolmentRequired(): ForbiddenException {
  return forbiddenWithReason(
    "TWO_FACTOR_ENROLMENT_REQUIRED",
    "This account must enrol two-factor authentication before signing in.",
  );
}

export function rateLimited(retryAfterSeconds: number): HttpException {
  return new HttpException(
    `Too many attempts. Retry in ${retryAfterSeconds} seconds.`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** Thrown by the repository when a unique email collides under concurrency. */
export class DuplicateEmailError extends Error {
  constructor() {
    super("A customer with this email already exists");
    this.name = "DuplicateEmailError";
  }
}
