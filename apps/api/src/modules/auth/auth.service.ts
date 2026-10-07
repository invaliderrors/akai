import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Customer, Role } from "@akai/contracts";
import { LOGGER } from "../observability/logger.module";
import { AUTH_REPOSITORY, type AuthRepository } from "./auth.repository";
import {
  DuplicateEmailError,
  invalidCredentials,
  invalidToken,
  rateLimited,
  twoFactorEnrolmentRequired,
} from "./auth.errors";
import {
  AUTH_POLICY,
  AUTH_RATE_LIMITS,
  emailRateLimitKey,
  type AuthPolicy,
  type AuthRateLimitBucket,
} from "./auth.policy";
import type {
  AuthCustomer,
  AuthenticatedUser,
  AuthLogger,
  RequestContext,
  SessionRecord,
  TokenPair,
} from "./auth.types";
import { AccessTokenService } from "./crypto/access-token.service";
import {
  generateOpaqueToken,
  generateRecoveryCodes,
  hashOpaqueToken,
  hashRecoveryCode,
} from "./crypto/opaque-token";
import { deriveEncryptionKey, open, seal } from "./crypto/secret-box";
import { TotpService } from "./crypto/totp.service";
import { CLOCK, type Clock } from "./ports/clock.port";
import {
  AUTH_EVENT_PUBLISHER,
  type AuthDomainEvent,
  type AuthEventPublisher,
} from "./ports/auth-events.port";
import {
  PASSWORD_HASHER,
  type PasswordHasher,
} from "./ports/password-hasher.port";
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiter,
  type RateLimitDecision,
} from "./ports/rate-limiter.port";
import type {
  Acknowledgement,
  ConfirmTotpBody,
  DisableTotpBody,
  LoginBody,
  LoginResult,
  LogoutBody,
} from "./dto/auth.dto";
import { ACKNOWLEDGEMENT } from "./dto/auth.dto";

/** Root secret for sealing TOTP secrets. See crypto/secret-box.ts. */
export interface AuthSecrets {
  readonly totpEncryptionRootSecret: string;
}

export const AUTH_SECRETS = Symbol("AUTH_SECRETS");

/**
 * Refresh-token TTL, injected separately from the policy because it comes
 * straight from REFRESH_TOKEN_TTL in validated config.
 */
export const REFRESH_TOKEN_TTL_MS = Symbol("REFRESH_TOKEN_TTL_MS");

/**
 * Roles for which a second factor is NOT optional (spec §8: "mandatory for
 * ADMIN"). A member of this set that has not enrolled TOTP cannot obtain a
 * session at all — enforced in `login`, so no privileged principal can ever
 * authenticate on a password alone. STAFF is intentionally not here: the spec
 * mandates 2FA for ADMIN, and the admin surface's fresh-assertion gate already
 * blocks an un-enrolled STAFF from anything privileged.
 *
 * THAT ARGUMENT ASSUMED A PASSWORD WAS ALWAYS REQUIRED, and emailed sign-in
 * codes broke the assumption: mailbox access alone would have minted a STAFF
 * session — no password, and nothing the victim notices (a password reset is
 * loud; this is silent). Rather than widen this set, `issueEmailOtp` and
 * `consumeEmailOtp` refuse ANY role but CUSTOMER, so a role added later is
 * excluded by default instead of inheriting a passwordless route. Codes are a
 * shopper convenience; staff sign in with a password.
 */
const ROLES_REQUIRING_TWO_FACTOR: readonly Role[] = ["ADMIN"];

interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly marketingConsent: boolean;
}

interface PasswordResetConfirmInput {
  readonly token: string;
  readonly password: string;
}

interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * The auth domain service.
 *
 * Everything here is written against `AuthRepository`, never Prisma, so the
 * security rules below are provable in unit tests with no database:
 *
 *   - a credential failure is INDISTINGUISHABLE from an unknown account
 *     (identical exception, and a dummy hash is verified so the timing matches);
 *   - a replayed refresh token revokes its entire family AND its session;
 *   - single-use tokens are consumed via a conditional write, so two concurrent
 *     redemptions cannot both succeed;
 *   - `role` on an authenticated request always comes from the database row,
 *     never from the JWT claim.
 */
@Injectable()
export class AuthService {
  /**
   * A real hash of a random value, verified when no account exists so that
   * "unknown email" costs the same wall-clock time as "wrong password".
   * Without it, login latency alone enumerates the customer table.
   *
   * Computed lazily and cached: doing it in the constructor would make module
   * initialisation await a deliberately slow KDF.
   */
  private dummyHashPromise: Promise<string> | null = null;

  private readonly totpKey: Buffer;

  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(AUTH_EVENT_PUBLISHER) private readonly events: AuthEventPublisher,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REFRESH_TOKEN_TTL_MS) private readonly refreshTokenTtlMs: number,
    @Inject(AUTH_SECRETS) secrets: AuthSecrets,
    @Inject(LOGGER) private readonly logger: AuthLogger,
    private readonly accessTokens: AccessTokenService,
    private readonly totp: TotpService,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: AuthRateLimiter,
  ) {
    this.totpKey = deriveEncryptionKey(secrets.totpEncryptionRootSecret);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Always returns the same acknowledgement, whether or not the address was
   * already registered. The real owner of an existing address gets a
   * "someone tried to sign up" mail instead of a verification mail — which is
   * the honest way to close the loop without telling the caller anything.
   */
  async register(input: RegisterInput): Promise<Acknowledgement> {
    // Before the lookup, so the budget is spent identically whether or not the
    // address exists. Every attempt past the first mails the real owner a
    // "someone tried to sign up" notice, which makes an uncapped register an
    // email bomb aimed at a KNOWN address.
    await this.consumeEmailBudget("register", input.email);

    const existing = await this.repository.findCustomerByEmail(input.email);
    if (existing !== null) {
      await this.publish({
        type: "auth.registration.duplicate_attempt",
        customerId: existing.id,
        email: existing.email,
        occurredAt: this.clock.now(),
      });
      return ACKNOWLEDGEMENT;
    }

    const passwordHash = await this.hasher.hash(input.password);
    const now = this.clock.now();

    let customer: AuthCustomer;
    try {
      customer = await this.repository.createCustomer({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        marketingConsentAt: input.marketingConsent ? now : null,
      });
    } catch (error: unknown) {
      // Lost a race against a concurrent signup for the same address. The
      // unique index is the real guarantee; the check above is only an
      // optimisation, so this branch must produce the identical neutral
      // response rather than a 409 that confirms the address is taken.
      if (error instanceof DuplicateEmailError) {
        return ACKNOWLEDGEMENT;
      }
      throw error;
    }

    const { rawToken, expiresAt } = await this.issueAuthToken(
      customer.id,
      "EMAIL_VERIFICATION",
      this.policy.emailVerificationTtlMs,
    );

    await this.publish({
      type: "auth.customer.registered",
      customerId: customer.id,
      email: customer.email,
      occurredAt: now,
      verificationToken: rawToken,
      expiresAt,
    });

    return ACKNOWLEDGEMENT;
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(input: LoginBody, context: RequestContext): Promise<LoginResult> {
    // FIRST, before the lookup and before the deliberately expensive KDF, so
    // that counting cannot depend on whether the address exists: a budget that
    // only counted — or only 429ed — for real accounts would be a brand-new
    // oracle sitting on top of the identical `invalidCredentials()` every
    // branch below is built around.
    //
    // IT DOES NOT BOUND KDF AMPLIFICATION, and it must not be read as if it
    // did. The bucket key is the address the caller supplies, so an attacker
    // rotating `a1@…`, `a2@…` opens a fresh budget on every request and still
    // drives one scrypt verify each time — on the one endpoint with no captcha.
    // The only key that survives rotation is a coarse one, and every coarse key
    // available here is the shared-bucket lockout this limiter exists to avoid.
    // Bounding it needs a global concurrency cap around the hasher, or a real
    // bot gate on login; both are out of scope here and neither is in place.
    await this.consumeEmailBudget("login", input.email);

    const customer = await this.repository.findCustomerByEmail(input.email);
    const now = this.clock.now();

    // Every rejection below throws the SAME exception. The `reason` only ever
    // reaches the logs.
    if (customer === null || customer.passwordHash === null) {
      await this.burnPasswordTime(input.password);
      this.logger.warn({ reason: "unknown-account" }, "Login rejected");
      throw invalidCredentials();
    }

    if (customer.anonymisedAt !== null) {
      await this.burnPasswordTime(input.password);
      this.logger.warn({ reason: "anonymised" }, "Login rejected");
      throw invalidCredentials();
    }

    if (customer.lockedUntil !== null && customer.lockedUntil.getTime() > now.getTime()) {
      await this.burnPasswordTime(input.password);
      this.logger.warn({ customerId: customer.id, reason: "locked" }, "Login rejected");
      throw invalidCredentials();
    }

    const passwordValid = await this.hasher.verify(customer.passwordHash, input.password);
    if (!passwordValid) {
      await this.recordFailure(customer);
      this.logger.warn({ customerId: customer.id, reason: "bad-password" }, "Login rejected");
      throw invalidCredentials();
    }

    // --- privileged accounts MUST have a second factor ---------------------
    // An ADMIN who never enrolled TOTP is blocked here rather than issued a
    // password-only session. This runs AFTER password verification so the check
    // is only ever reachable by someone already holding the credentials, and it
    // fails closed: there is no code to prompt for, so the account must complete
    // enrolment before it can sign in (spec §8).
    if (
      customer.totpEnabledAt === null &&
      ROLES_REQUIRING_TWO_FACTOR.includes(customer.role)
    ) {
      this.logger.error(
        { customerId: customer.id, role: customer.role, reason: "admin-2fa-missing" },
        "Privileged account without an enrolled second factor was blocked from signing in",
      );
      throw twoFactorEnrolmentRequired();
    }

    // --- second factor -----------------------------------------------------
    let twoFactorAssertedAt: Date | null = null;

    if (customer.totpEnabledAt !== null) {
      const supplied = input.totpCode ?? input.recoveryCode;
      if (supplied === undefined) {
        // Credentials were right, but NO session and NO tokens are created and
        // the customer object is withheld — a correct password alone must not
        // reveal the account holder's identity.
        return { requiresTwoFactor: true };
      }

      const secondFactorValid = await this.verifySecondFactor(customer, input, now);
      if (!secondFactorValid) {
        await this.recordFailure(customer);
        this.logger.warn({ customerId: customer.id, reason: "bad-2fa" }, "Login rejected");
        throw invalidCredentials();
      }
      twoFactorAssertedAt = now;
    }

    await this.repository.clearFailedLogins(customer.id);
    // One success forgives the burst, so a typo streak does not leave the real
    // owner one attempt from a 429 on their own account. Only reachable by a
    // caller who has already presented the password AND any second factor, so
    // it is not a budget an attacker can refill.
    await this.forgiveEmailBudget("login", input.email);

    // Opportunistic upgrade to current KDF parameters. This is the only moment
    // the plaintext is available, so it is the only moment a rehash is possible.
    if (this.hasher.needsRehash(customer.passwordHash)) {
      await this.repository.updatePasswordHash(
        customer.id,
        await this.hasher.hash(input.password),
      );
    }

    const tokens = await this.createSessionWithTokens(customer, context, twoFactorAssertedAt);

    return {
      customer: toPublicCustomer(customer),
      requiresTwoFactor: false,
      tokens: serialiseTokens(tokens),
    };
  }

  /**
   * Narrower than `LoginBody` on purpose: the emailed-code path needs this same
   * gate and has no password to hand it. Typing the parameter as the two fields
   * it actually reads keeps both callers honest and keeps the 2FA rule in ONE
   * place — a second copy of it is how a sign-in route ends up skipping it.
   */
  private async verifySecondFactor(
    customer: AuthCustomer,
    input: {
      readonly totpCode?: string | undefined;
      readonly recoveryCode?: string | undefined;
    },
    now: Date,
  ): Promise<boolean> {
    if (input.recoveryCode !== undefined) {
      // Single-use, enforced by a conditional write in the repository so two
      // concurrent submissions of the same code cannot both succeed.
      return this.repository.consumeRecoveryCode(
        customer.id,
        hashRecoveryCode(input.recoveryCode),
        now,
      );
    }

    if (input.totpCode === undefined || customer.totpSecret === null) {
      return false;
    }

    const secret = open(customer.totpSecret, this.totpKey);
    if (secret === null) {
      // Sealed secret will not open: wrong key or a tampered row. Fail closed
      // and make it loud — this is an operational alarm, not a user error.
      this.logger.error(
        { customerId: customer.id },
        "TOTP secret could not be decrypted",
      );
      return false;
    }

    return this.totp.verify(secret, input.totpCode, now).valid;
  }

  // -------------------------------------------------------------------------
  // Emailed one-time sign-in codes
  // -------------------------------------------------------------------------

  /**
   * Mail a six-digit sign-in code, or pretend to.
   *
   * NEUTRAL FOR EVERY ADDRESS, in body AND in cost. The response is the same
   * `ACKNOWLEDGEMENT` the register and reset routes return, the budget is spent
   * before the lookup, and an address with no account still burns the code
   * generation, the digest and one read against `email_otp` (`burnEmailOtpTime`).
   * Anti-enumeration in this module is structural — one `invalidCredentials()`
   * everywhere, a dummy scrypt verify on login — and a request path that is fast
   * for strangers and slow for customers is a new oracle bolted onto all of it.
   *
   * WHAT IS NOT EQUALISED, stated so nobody assumes it is: the real path also
   * writes the row, one INSERT more than the burn. Closing that would need a
   * dummy write, and there is no row a non-existent customer can own.
   */
  async issueEmailOtp(email: string): Promise<Acknowledgement> {
    // Before the lookup, so counting cannot depend on whether the address
    // exists — and because this route sends mail to an address the caller
    // names, which is an email-bomb surface before it is an auth one.
    await this.consumeEmailBudget("loginCodeRequest", email);

    const customer = await this.repository.findCustomerByEmail(email);
    const now = this.clock.now();

    if (customer === null || customer.anonymisedAt !== null) {
      await this.burnEmailOtpTime();
      return ACKNOWLEDGEMENT;
    }

    // PRIVILEGED ACCOUNTS GET NO CODE, and are answered exactly as an unknown
    // address is — same acknowledgement, same burnt work — so this cannot become
    // an oracle for "which of these addresses is staff".
    if (customer.role !== "CUSTOMER") {
      await this.burnEmailOtpTime();
      this.logger.warn(
        { customerId: customer.id, role: customer.role, reason: "privileged-role" },
        "Sign-in code refused for a privileged account",
      );
      return ACKNOWLEDGEMENT;
    }

    const code = generateLoginCode();
    const expiresAt = new Date(now.getTime() + this.policy.loginCodeTtlMs);

    // UPSERT keyed on the customer: the primary key is what makes "one live
    // code" true under concurrency, and re-issuing resets the attempt counter.
    await this.repository.upsertEmailOtp({
      customerId: customer.id,
      // Only the digest is stored, and it is bound to the customer. See the
      // `EmailOtp` doc comment in schema.prisma for why `auth_token` was refused.
      codeHash: hashLoginCode(customer.id, code),
      expiresAt,
    });

    // DELIVERY. Without this the endpoint wrote a row, spent the customer's
    // budget, answered 202 and mailed nothing — a silent dead end, and worse
    // once combined with the upsert: a stranger posting this address would
    // replace the code the customer was mid-way through typing.
    await this.publish({
      type: "auth.login_code.requested",
      customerId: customer.id,
      email: customer.email,
      occurredAt: now,
      code,
      expiresAt,
    });

    return ACKNOWLEDGEMENT;
  }

  /**
   * Redeem a mailed code and mint a session.
   *
   * Both existing gates are reproduced here, and neither is optional: an ADMIN
   * with no enrolled TOTP gets NO session at all (a mailed code must not be a
   * route around mandatory two-factor), and an enrolled account still has to
   * clear the second factor afterwards. Skipping either would make this endpoint
   * a privilege escalation rather than a convenience.
   *
   * The session is minted through `createSessionWithTokens`, so refresh-token
   * families and reuse detection hold exactly as they do for a password login.
   */
  async consumeEmailOtp(
    input: {
      readonly email: string;
      readonly loginCode: string;
      readonly totpCode?: string | undefined;
    },
    context: RequestContext,
  ): Promise<LoginResult> {
    await this.consumeEmailBudget("loginCodeVerify", input.email);

    const customer = await this.repository.findCustomerByEmail(input.email);
    const now = this.clock.now();

    // Every rejection below throws the SAME exception as a failed password.
    if (customer === null || customer.anonymisedAt !== null) {
      await this.burnEmailOtpTime();
      this.logger.warn({ reason: "unknown-account" }, "Sign-in code rejected");
      throw invalidCredentials();
    }

    // `lockedUntil` IS DELIBERATELY NOT CHECKED HERE, and that is the whole
    // point of this route: ten bad passwords from a stranger must not cost the
    // mailbox owner their way back in. `confirmPasswordReset` reasons the same
    // way. The asymmetry that WOULD be wrong — arming a lockout this path then
    // exempts itself from — is fixed at the other end, below: this route no
    // longer calls `recordFailure` at all.

    // Same refusal as issuing: a role can change between the two legs.
    if (customer.role !== "CUSTOMER") {
      this.logger.error(
        { customerId: customer.id, role: customer.role, reason: "privileged-role" },
        "Sign-in code refused for a privileged account",
      );
      throw invalidCredentials();
    }

    // BY CUSTOMER, never by hash: a lookup keyed on the digest of a six-digit
    // secret authenticates whichever row happens to match it.
    const record = await this.repository.findEmailOtp(customer.id);
    if (
      record === null ||
      record.consumedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      this.logger.warn(
        { customerId: customer.id, reason: "no-live-code" },
        "Sign-in code rejected",
      );
      throw invalidCredentials();
    }

    if (record.attempts >= this.policy.loginCodeMaxAttempts) {
      await this.repository.deleteEmailOtp(customer.id);
      this.logger.warn(
        { customerId: customer.id, reason: "attempts-exhausted" },
        "Sign-in code burnt",
      );
      throw invalidCredentials();
    }

    if (!digestsMatch(record.codeHash, hashLoginCode(customer.id, input.loginCode))) {
      const attempts = await this.repository.recordEmailOtpAttempt(customer.id);
      // Null means a concurrent request already burnt it. Either way the code
      // is spent: guesses are bounded PER ISSUANCE, so an attacker cannot buy
      // a fresh budget by changing source address.
      if (attempts === null || attempts >= this.policy.loginCodeMaxAttempts) {
        await this.repository.deleteEmailOtp(customer.id);
      }
      this.logger.warn(
        { customerId: customer.id, reason: "bad-code" },
        "Sign-in code rejected",
      );
      throw invalidCredentials();
    }

    // --- privileged accounts MUST have a second factor ---------------------
    // Same rule as `login`, reached only by a caller holding the mailed code.
    // There is no code to prompt for, so it fails closed.
    if (
      customer.totpEnabledAt === null &&
      ROLES_REQUIRING_TWO_FACTOR.includes(customer.role)
    ) {
      this.logger.error(
        { customerId: customer.id, role: customer.role, reason: "admin-2fa-missing" },
        "Privileged account without an enrolled second factor was blocked from signing in",
      );
      throw twoFactorEnrolmentRequired();
    }

    // --- second factor -----------------------------------------------------
    let twoFactorAssertedAt: Date | null = null;

    if (customer.totpEnabledAt !== null) {
      if (input.totpCode === undefined) {
        // THE CODE IS DELIBERATELY NOT CONSUMED HERE. The client answers the
        // challenge by re-posting this same code alongside the TOTP, so
        // spending it on the challenge leg would make the second leg
        // impossible. The attempt counter and the TTL still bound its life.
        return { requiresTwoFactor: true };
      }

      const secondFactorValid = await this.verifySecondFactor(
        customer,
        { totpCode: input.totpCode },
        now,
      );
      if (!secondFactorValid) {
        // THE PER-CODE COUNTER, AND ONLY IT. Without this the mailed code
        // bounded nothing on this leg: a holder of a valid code could spend its
        // whole TTL guessing TOTPs at the verify budget's rate and the code
        // would never die. The per-issuance cap is the guarantee this design
        // leans on, so it must apply to every way a redemption fails, not only
        // to a mistyped code.
        //
        // AND DELIBERATELY NOT `recordFailure`. This route ignores `lockedUntil`
        // on purpose (see above), so arming that lockout from here would let an
        // attacker holding a stolen code lock the real owner out of PASSWORD
        // sign-in while this route stayed open to them — a lockout armed by a
        // path that exempts itself from it. Guesses here are bounded by the
        // per-issuance cap and the verify budget instead.
        const attempts = await this.repository.recordEmailOtpAttempt(customer.id);
        this.logger.warn(
          { customerId: customer.id, reason: "bad-2fa", attempts },
          "Sign-in code rejected",
        );
        throw invalidCredentials();
      }
      twoFactorAssertedAt = now;
    }

    // Conditional write. False means a concurrent request redeemed it first,
    // which is indistinguishable from a replay and treated as one.
    const consumed = await this.repository.consumeEmailOtp(
      customer.id,
      record.codeHash,
      now,
    );
    if (!consumed) {
      this.logger.warn(
        { customerId: customer.id, reason: "code-already-consumed" },
        "Sign-in code rejected",
      );
      throw invalidCredentials();
    }

    // The mailbox owner just proved themselves. Leaving the lockout armed would
    // let an attacker hold them out of BOTH sign-in routes with ten bad
    // passwords — the same reasoning `confirmPasswordReset` follows.
    await this.repository.clearFailedLogins(customer.id);
    await this.forgiveEmailBudget("loginCodeVerify", input.email);

    // Receiving the code proves mailbox control exactly as redeeming a
    // verification link does. Without this a code-only customer — the password
    // hash is nullable — stays "unverified" for ever.
    const emailVerifiedAt = customer.emailVerifiedAt ?? now;
    if (customer.emailVerifiedAt === null) {
      await this.repository.markEmailVerified(customer.id, now);
    }

    const tokens = await this.createSessionWithTokens(customer, context, twoFactorAssertedAt);

    return {
      customer: toPublicCustomer({ ...customer, emailVerifiedAt }),
      requiresTwoFactor: false,
      tokens: serialiseTokens(tokens),
    };
  }

  /**
   * The work an address with no account still pays for.
   *
   * One code generation, one digest and one read against `email_otp` for an id
   * nobody owns — the same shape as the real path minus the write it cannot do.
   */
  private async burnEmailOtpTime(): Promise<void> {
    const decoy = randomUUID();
    void hashLoginCode(decoy, generateLoginCode());
    await this.repository.findEmailOtp(decoy);
  }

  // -------------------------------------------------------------------------
  // Refresh — rotation with reuse detection
  // -------------------------------------------------------------------------

  /**
   * Rotates a refresh token.
   *
   * The security property: a token is valid exactly once. Presenting a
   * previously-consumed token means either an attacker stole it and the real
   * user already rotated, or vice versa — and since we cannot tell which, the
   * only safe response is to revoke the WHOLE family and the session with it,
   * logging both parties out. That is the reuse-detection scheme spec §8
   * requires, and it is why rotation must write a new row rather than update
   * one in place.
   */
  async refresh(rawToken: string, context: RequestContext): Promise<TokenPair> {
    const now = this.clock.now();
    const record = await this.repository.findRefreshTokenByHash(hashOpaqueToken(rawToken));

    if (record === null) {
      throw invalidToken();
    }

    if (record.consumedAt !== null) {
      await this.handleReuse(record.familyId, record.sessionId, record.customerId, now, context);
      throw invalidToken();
    }

    if (record.revokedAt !== null || record.expiresAt.getTime() <= now.getTime()) {
      throw invalidToken();
    }

    // Conditional consume. A false result means a concurrent request won the
    // race, which is indistinguishable from a replay — treated as one.
    const consumed = await this.repository.consumeRefreshToken(record.id, now);
    if (!consumed) {
      await this.handleReuse(record.familyId, record.sessionId, record.customerId, now, context);
      throw invalidToken();
    }

    const session = await this.repository.findSessionById(record.sessionId);
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw invalidToken();
    }

    const customer = await this.repository.findCustomerById(record.customerId);
    if (customer === null || customer.anonymisedAt !== null) {
      throw invalidToken();
    }

    await this.repository.touchSession(session.id, now);

    /**
     * SLIDING TWO-FACTOR ASSERTION — A DELIBERATE POLICY DECISION, NOT A BUG.
     *
     * Spec §8 makes the step-up a FRESHNESS check: `RolesGuard` refuses an
     * elevated route when `twoFactorAssertedAt` is older than
     * `twoFactorFreshnessMs`. Renewing it on every rotation makes that window
     * slide, so an admin who keeps using the dashboard is never re-prompted.
     *
     * WHAT THIS COSTS, stated so nobody has to rediscover it: the second factor
     * is now proved exactly ONCE, at sign-in. After that the assertion rides the
     * refresh cycle for the life of the session — up to `sessionTtlMs` (30 days).
     * A stolen session cookie is therefore stolen ADMIN access for as long as it
     * keeps rotating, where before it was useless for admin routes after 15
     * minutes. The step-up no longer bounds the blast radius of a hijack; only
     * session revocation does.
     *
     * Requested explicitly, weighed against the alternatives (stepping up only
     * on mutations, a longer fixed window, or an inline re-prompt) and chosen
     * over them. Revisit it before this surface is exposed to a wider set of
     * operators, or scope the renewal to non-mutating routes.
     *
     * RENEWED, NEVER CREATED. The guard is `!== null`: a session that never
     * proved a second factor must not acquire one by refreshing. Without that
     * check a password-only session would silently gain the step-up claim, which
     * would be a privilege escalation rather than a convenience.
     */
    if (session.twoFactorAssertedAt !== null) {
      await this.repository.markTwoFactorAsserted(session.id, now);
    }

    // Role is re-read from the customer row here, so a demotion applied while a
    // session was live is reflected in the very next access token.
    return this.issueTokenPair(customer, session, record.familyId);
  }

  private async handleReuse(
    familyId: string,
    sessionId: string,
    customerId: string,
    now: Date,
    context: RequestContext,
  ): Promise<void> {
    await this.repository.revokeRefreshTokenFamily(familyId, now);
    await this.repository.revokeSession(sessionId, now);

    // The presenting client is recorded deliberately: the IP and user agent
    // that replayed a rotated token are the first thing a security
    // investigation asks for, and they are unrecoverable after the fact.
    this.logger.error(
      {
        customerId,
        familyId,
        sessionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      "Refresh token reuse detected — family revoked",
    );

    const customer = await this.repository.findCustomerById(customerId);
    if (customer !== null) {
      await this.publish({
        type: "auth.refresh_token.reuse_detected",
        customerId,
        email: customer.email,
        occurredAt: now,
        familyId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------

  async logout(user: AuthenticatedUser, input: LogoutBody): Promise<Acknowledgement> {
    const now = this.clock.now();

    if (input.allDevices) {
      await this.repository.revokeAllRefreshTokens(user.customerId, now);
      await this.repository.revokeAllSessions(user.customerId, now, null);
      return ACKNOWLEDGEMENT;
    }

    await this.repository.revokeSession(user.sessionId, now);

    // Revoke the presented token's family too. Revoking only the session would
    // leave a live refresh token that could mint a session again.
    if (input.refreshToken !== undefined) {
      const record = await this.repository.findRefreshTokenByHash(
        hashOpaqueToken(input.refreshToken),
      );
      // Ownership check: a caller must not be able to revoke a stranger's
      // token family by presenting a token they happen to have obtained.
      if (record !== null && record.customerId === user.customerId) {
        await this.repository.revokeRefreshTokenFamily(record.familyId, now);
      }
    }

    return ACKNOWLEDGEMENT;
  }

  // -------------------------------------------------------------------------
  // Access-token authentication (used by JwtAuthGuard)
  // -------------------------------------------------------------------------

  /**
   * Resolves a bearer token to a principal, or null.
   *
   * Returns null rather than throwing for every rejection so the guard owns the
   * response shape, and so no branch here can accidentally leak WHY a token was
   * rejected to the caller.
   */
  async authenticate(accessToken: string): Promise<AuthenticatedUser | null> {
    const verification = this.accessTokens.verify(accessToken);
    if (!verification.ok) {
      return null;
    }

    const { payload } = verification;
    const now = this.clock.now();

    const session = await this.repository.findSessionById(payload.sessionId);
    if (session === null) {
      return null;
    }

    // A valid signature over a revoked session must still fail. This lookup is
    // what makes logout and reuse-revocation take effect immediately instead of
    // at the end of the access token's 15-minute life.
    if (session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    // Binds the token to its session. A token whose `sub` disagrees with the
    // session's owner is a forgery attempt or a serious bug; either way, deny.
    if (session.customerId !== payload.sub) {
      this.logger.error(
        { sessionId: session.id },
        "Access token subject does not match session owner",
      );
      return null;
    }

    const customer = await this.repository.findCustomerById(session.customerId);
    if (customer === null || customer.anonymisedAt !== null) {
      return null;
    }

    if (
      now.getTime() - session.lastSeenAt.getTime() >=
      this.policy.sessionTouchIntervalMs
    ) {
      await this.repository.touchSession(session.id, now);
    }

    return {
      customerId: customer.id,
      sessionId: session.id,
      // FROM THE DATABASE, never `payload.role` (spec §8).
      role: customer.role,
      email: customer.email,
      emailVerified: customer.emailVerifiedAt !== null,
      twoFactorAssertedAt: session.twoFactorAssertedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Email verification
  // -------------------------------------------------------------------------

  async verifyEmail(rawToken: string): Promise<Acknowledgement> {
    const now = this.clock.now();
    const record = await this.consumeAuthToken(rawToken, "EMAIL_VERIFICATION", now);

    const customer = await this.repository.findCustomerById(record.customerId);
    if (customer === null) {
      throw invalidToken();
    }

    if (customer.emailVerifiedAt === null) {
      await this.repository.markEmailVerified(customer.id, now);
    }

    await this.publish({
      type: "auth.email_verification.completed",
      customerId: customer.id,
      email: customer.email,
      occurredAt: now,
    });

    return ACKNOWLEDGEMENT;
  }

  /** Neutral response regardless of whether the address exists or is verified. */
  async resendVerification(email: string): Promise<Acknowledgement> {
    await this.consumeEmailBudget("resendVerification", email);

    const customer = await this.repository.findCustomerByEmail(email);

    if (
      customer !== null &&
      customer.anonymisedAt === null &&
      customer.emailVerifiedAt === null
    ) {
      await this.repository.invalidateAuthTokens(
        customer.id,
        "EMAIL_VERIFICATION",
        this.clock.now(),
      );
      const { rawToken, expiresAt } = await this.issueAuthToken(
        customer.id,
        "EMAIL_VERIFICATION",
        this.policy.emailVerificationTtlMs,
      );

      await this.publish({
        type: "auth.email_verification.requested",
        customerId: customer.id,
        email: customer.email,
        occurredAt: this.clock.now(),
        verificationToken: rawToken,
        expiresAt,
      });
    }

    return ACKNOWLEDGEMENT;
  }

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------

  async requestPasswordReset(email: string): Promise<Acknowledgement> {
    await this.consumeEmailBudget("passwordResetRequest", email);

    const customer = await this.repository.findCustomerByEmail(email);
    const now = this.clock.now();

    if (customer !== null && customer.anonymisedAt === null) {
      // Only one live reset link at a time: a mailbox holding five valid links
      // is five chances for one of them to leak.
      await this.repository.invalidateAuthTokens(customer.id, "PASSWORD_RESET", now);

      const { rawToken, expiresAt } = await this.issueAuthToken(
        customer.id,
        "PASSWORD_RESET",
        this.policy.passwordResetTtlMs,
      );

      await this.publish({
        type: "auth.password_reset.requested",
        customerId: customer.id,
        email: customer.email,
        occurredAt: now,
        resetToken: rawToken,
        expiresAt,
      });
    }

    return ACKNOWLEDGEMENT;
  }

  async confirmPasswordReset(input: PasswordResetConfirmInput): Promise<Acknowledgement> {
    const now = this.clock.now();
    const record = await this.consumeAuthToken(input.token, "PASSWORD_RESET", now);

    const customer = await this.repository.findCustomerById(record.customerId);
    if (customer === null || customer.anonymisedAt !== null) {
      throw invalidToken();
    }

    await this.repository.updatePasswordHash(
      customer.id,
      await this.hasher.hash(input.password),
    );

    // A reset is the response to a suspected compromise, so every existing
    // credential is destroyed: all refresh families, all sessions, and any
    // other outstanding reset links.
    await this.repository.revokeAllRefreshTokens(customer.id, now);
    await this.repository.revokeAllSessions(customer.id, now, null);
    await this.repository.invalidateAuthTokens(customer.id, "PASSWORD_RESET", now);

    // Redeeming the link proves control of the mailbox, which is exactly what
    // verification asks for — so a reset also clears an unverified address.
    if (customer.emailVerifiedAt === null) {
      await this.repository.markEmailVerified(customer.id, now);
    }

    // The lockout is lifted: the legitimate owner just proved themselves, and
    // leaving it armed would let an attacker lock someone out at will.
    await this.repository.clearFailedLogins(customer.id);

    await this.publish({
      type: "auth.password_reset.completed",
      customerId: customer.id,
      email: customer.email,
      occurredAt: now,
    });

    return ACKNOWLEDGEMENT;
  }

  async changePassword(
    user: AuthenticatedUser,
    input: ChangePasswordInput,
  ): Promise<Acknowledgement> {
    const customer = await this.repository.findCustomerById(user.customerId);
    if (customer === null || customer.passwordHash === null) {
      throw invalidCredentials();
    }

    const valid = await this.hasher.verify(customer.passwordHash, input.currentPassword);
    if (!valid) {
      throw invalidCredentials();
    }

    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException("New password must differ from the current one");
    }

    const now = this.clock.now();
    await this.repository.updatePasswordHash(
      customer.id,
      await this.hasher.hash(input.newPassword),
    );

    // Every OTHER device is signed out; the session that performed the change
    // survives, so a deliberate password rotation is not self-inflicted logout.
    await this.repository.revokeAllRefreshTokens(customer.id, now);
    await this.repository.revokeAllSessions(customer.id, now, user.sessionId);

    await this.publish({
      type: "auth.password.changed",
      customerId: customer.id,
      email: customer.email,
      occurredAt: now,
    });

    return ACKNOWLEDGEMENT;
  }

  // -------------------------------------------------------------------------
  // Two-factor enrolment
  // -------------------------------------------------------------------------

  /**
   * Step 1. Generates a secret and returns it with a QR URI, WITHOUT persisting
   * anything. Storing it here would half-enrol an account if the user never
   * completes the scan, and for an ADMIN that means locked out of the admin
   * surface with no way back.
   */
  async beginTotpEnrolment(
    user: AuthenticatedUser,
  ): Promise<{ secret: string; keyUri: string }> {
    // The email is re-read rather than taken from the principal: the principal
    // deliberately does not carry it, and a blank label in an authenticator app
    // is how a user with two accounts locks themselves out of the wrong one.
    const customer = await this.repository.findCustomerById(user.customerId);
    if (customer === null) {
      throw invalidCredentials();
    }

    const secret = this.totp.generateSecret();
    return { secret, keyUri: this.totp.keyUri(secret, customer.email) };
  }

  /** Step 2. Proof of possession before the secret is stored. */
  async confirmTotpEnrolment(
    user: AuthenticatedUser,
    input: ConfirmTotpBody,
  ): Promise<{ recoveryCodes: string[] }> {
    const now = this.clock.now();

    if (!this.totp.verify(input.secret, input.code, now).valid) {
      throw new BadRequestException("Invalid authentication code");
    }

    await this.repository.setTotpSecret(
      user.customerId,
      seal(input.secret, this.totpKey),
      now,
    );

    const codes = generateRecoveryCodes(this.policy.recoveryCodeCount);
    await this.repository.replaceRecoveryCodes(
      user.customerId,
      codes.map((code) => hashRecoveryCode(code)),
    );

    // This session has just proved a second factor, so it is marked fresh —
    // otherwise an admin who enrols is immediately asked to prove 2FA again.
    await this.repository.markTwoFactorAsserted(user.sessionId, now);

    const customer = await this.repository.findCustomerById(user.customerId);
    if (customer !== null) {
      await this.publish({
        type: "auth.two_factor.enabled",
        customerId: customer.id,
        email: customer.email,
        occurredAt: now,
      });
    }

    // Returned exactly once. Only SHA-256 hashes are stored, so no endpoint can
    // ever show these again.
    return { recoveryCodes: codes };
  }

  /** Re-authenticates with the password: holding the device is not enough. */
  async disableTotp(
    user: AuthenticatedUser,
    input: DisableTotpBody,
  ): Promise<Acknowledgement> {
    const customer = await this.repository.findCustomerById(user.customerId);
    if (customer === null || customer.passwordHash === null) {
      throw invalidCredentials();
    }

    if (!(await this.hasher.verify(customer.passwordHash, input.password))) {
      throw invalidCredentials();
    }

    const now = this.clock.now();
    await this.repository.setTotpSecret(customer.id, null, null);
    await this.repository.replaceRecoveryCodes(customer.id, []);

    await this.publish({
      type: "auth.two_factor.disabled",
      customerId: customer.id,
      email: customer.email,
      occurredAt: now,
    });

    return ACKNOWLEDGEMENT;
  }

  // -------------------------------------------------------------------------
  // Profile / sessions
  // -------------------------------------------------------------------------

  async currentCustomer(user: AuthenticatedUser): Promise<Customer> {
    const customer = await this.repository.findCustomerById(user.customerId);
    if (customer === null) {
      throw invalidCredentials();
    }
    return toPublicCustomer(customer);
  }

  async listSessions(user: AuthenticatedUser): Promise<readonly SessionRecord[]> {
    return this.repository.listActiveSessions(user.customerId, this.clock.now());
  }

  /** Ownership-scoped: a customer may only revoke their OWN sessions. */
  async revokeSession(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<Acknowledgement> {
    const session = await this.repository.findSessionById(sessionId);

    // 200 for a stranger's session id as well as a missing one. Returning 403
    // would confirm the id exists and let sessions be enumerated.
    if (session !== null && session.customerId === user.customerId) {
      await this.repository.revokeSession(sessionId, this.clock.now());
    }

    return ACKNOWLEDGEMENT;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createSessionWithTokens(
    customer: AuthCustomer,
    context: RequestContext,
    twoFactorAssertedAt: Date | null,
  ): Promise<TokenPair> {
    const now = this.clock.now();
    const session = await this.repository.createSession({
      customerId: customer.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      expiresAt: new Date(now.getTime() + this.policy.sessionTtlMs),
      twoFactorAssertedAt,
    });

    // A fresh login starts a NEW family. Families are what bound the blast
    // radius of a reuse revocation to a single device.
    return this.issueTokenPair(customer, session, randomUUID());
  }

  private async issueTokenPair(
    customer: AuthCustomer,
    session: SessionRecord,
    familyId: string,
  ): Promise<TokenPair> {
    const now = this.clock.now();

    const access = this.accessTokens.issue({
      customerId: customer.id,
      sessionId: session.id,
      role: customer.role,
    });

    const rawRefresh = generateOpaqueToken();
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTokenTtlMs);

    await this.repository.createRefreshToken({
      customerId: customer.id,
      sessionId: session.id,
      familyId,
      // Only the hash is persisted. A database dump yields nothing replayable.
      tokenHash: hashOpaqueToken(rawRefresh),
      expiresAt: refreshExpiresAt,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: rawRefresh,
      refreshTokenExpiresAt: refreshExpiresAt,
      sessionId: session.id,
    };
  }

  private async issueAuthToken(
    customerId: string,
    purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET",
    ttlMs: number,
  ): Promise<{ rawToken: string; expiresAt: Date }> {
    const rawToken = generateOpaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + ttlMs);

    await this.repository.createAuthToken({
      customerId,
      purpose,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt,
    });

    return { rawToken, expiresAt };
  }

  /**
   * Validates and atomically consumes a single-use token.
   *
   * The purpose check matters: without it, an email-verification token (issued
   * freely, long-lived) could be redeemed at the password-reset endpoint and
   * used to take over the account.
   */
  private async consumeAuthToken(
    rawToken: string,
    purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET",
    now: Date,
  ): Promise<{ customerId: string }> {
    const record = await this.repository.findAuthTokenByHash(hashOpaqueToken(rawToken));

    if (
      record === null ||
      record.purpose !== purpose ||
      record.usedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw invalidToken();
    }

    const consumed = await this.repository.consumeAuthToken(record.id, now);
    if (!consumed) {
      throw invalidToken();
    }

    return { customerId: record.customerId };
  }

  private async recordFailure(customer: AuthCustomer): Promise<void> {
    const now = this.clock.now();
    const nextCount = customer.failedLoginCount + 1;
    const shouldLock = nextCount >= this.policy.maxFailedLogins;
    const lockedUntil = shouldLock
      ? new Date(now.getTime() + this.policy.lockoutMs)
      : null;

    await this.repository.recordFailedLogin(customer.id, lockedUntil);

    if (lockedUntil !== null) {
      await this.publish({
        type: "auth.account.locked",
        customerId: customer.id,
        email: customer.email,
        occurredAt: now,
        lockedUntil,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Per-email rate limiting
  // -------------------------------------------------------------------------

  /**
   * Spend one unit of `bucket`'s budget for `email`, refusing the request when
   * it is exhausted.
   *
   * WHY THIS IS HERE AND NOT ON A GUARD. `AuthRateLimitGuard` keys on the
   * socket address, and Express `trust proxy` is deliberately unset. Every
   * customer reaches this API through the Next BFF route handlers, so the
   * socket address is the storefront/dashboard CONTAINER's for all of them —
   * one bucket for the entire user base, in which a spent `refresh` budget
   * signs everyone out and a spent `login` budget stops them signing back in.
   * The service layer is the first place the request BODY is visible, and the
   * address in it is the only per-account key available. See auth.policy.ts.
   *
   * IT MUST BEHAVE IDENTICALLY FOR EVERY ADDRESS. Anti-enumeration in this
   * module is structural: one `invalidCredentials()` for every rejection, and a
   * dummy scrypt verify to equalise latency. A budget that only counted — or
   * only 429ed — for addresses that exist would be a brand-new oracle sitting
   * on top of all of it. So this runs before any lookup, for everyone.
   *
   * THE TRADE IT MAKES, STATED PLAINLY. Keying on the address means an
   * attacker who knows one can spend its budget on purpose. Ten bad logins per
   * window also arm `lockedUntil`, and the reset budget is small, so a victim
   * can be held out of BOTH sign-in and account recovery for a handful of
   * requests an hour — and recovery was previously the escape hatch from the
   * lockout. That is the defining cost of per-account keying and it is
   * accepted here only because the alternative, keying on the socket address,
   * locks out every customer at once rather than one. It argues for keeping
   * the mail-bearing budgets generous: the scarce resource on those routes is
   * outbound mail, and re-issuing a token inside a window costs one message
   * rather than one per attempt.
   *
   * The address is deliberately NOT logged. `rate_limit_counter` already holds
   * the key, which is where an operator should look; duplicating it into the
   * log stream turns every throttled sign-in into retained PII.
   */
  private async consumeEmailBudget(
    bucket: AuthRateLimitBucket,
    email: string,
  ): Promise<void> {
    const rule = AUTH_RATE_LIMITS[bucket];

    let decision: RateLimitDecision;
    try {
      decision = await this.rateLimiter.consume(
        emailRateLimitKey(bucket, email),
        rule.limit,
        rule.windowMs,
      );
    } catch (error: unknown) {
      // FAIL OPEN, deliberately, and note that this is the OPPOSITE of the
      // unused guard, which lets a store error propagate as a 500.
      //
      // The counter lives in one ordinary table that this process writes on
      // every sign-in. Failing closed converts any fault on it — bloat, a lock,
      // a migration, a permission slip — into a total authentication outage for
      // every customer and every admin, including the admins who would fix it.
      // Failing open costs only the throttle, and the throttle is not the only
      // control: the DURABLE account lockout in
      // `customer.failedLoginCount`/`lockedUntil` is on a different table,
      // survives this one being down, and independently bounds brute force
      // against any single account. Availability is chosen where a second
      // control still holds; it would not be chosen if this were the only one.
      this.logger.error(
        { err: error, bucket },
        "Auth rate limiter unavailable; allowing the request (account lockout still applies)",
      );
      return;
    }

    if (!decision.allowed) {
      this.logger.warn({ bucket, reason: "rate-limited" }, "Auth request throttled");
      throw rateLimited(decision.retryAfterSeconds);
    }
  }

  /** Clear an address's budget. See the call site in `login` for why. */
  private async forgiveEmailBudget(
    bucket: AuthRateLimitBucket,
    email: string,
  ): Promise<void> {
    try {
      await this.rateLimiter.reset(emailRateLimitKey(bucket, email));
    } catch (error: unknown) {
      // A failed reset leaves a stale budget that expires on its own. Failing
      // the login over it would turn a limiter fault into the outage the
      // fail-open above exists to avoid.
      this.logger.error(
        { err: error, bucket },
        "Failed to clear an auth rate-limit budget after a successful login",
      );
    }
  }

  /**
   * Spends roughly one password-verification's worth of time on a request that
   * has already failed, so the response latency of "no such account" matches
   * "wrong password".
   */
  private async burnPasswordTime(candidate: string): Promise<void> {
    this.dummyHashPromise ??= this.hasher.hash(
      `akai-timing-equaliser-${randomUUID()}`,
    );
    await this.hasher.verify(await this.dummyHashPromise, candidate);
  }

  /**
   * Event publication must never fail the operation that produced it. A
   * verification email that could not be enqueued is a retryable annoyance; a
   * registration that 500s after the customer row was committed is a corrupt
   * account the user cannot re-create (the address is now taken).
   */
  private async publish(event: AuthDomainEvent): Promise<void> {
    try {
      await this.events.publish(event);
    } catch (error: unknown) {
      this.logger.error(
        { err: error, eventType: event.type, customerId: event.customerId },
        "Failed to publish auth domain event",
      );
    }
  }
}

/** Six digits: the space the `email_otp` attempt cap is sized against. */
const LOGIN_CODE_DIGITS = 6;

/**
 * A six-digit sign-in code.
 *
 * `randomInt` is the rejection-sampling CSPRNG helper — the same approach as
 * `generateRecoveryCode`, and for the same reason. `bytes[i] % 10` is biased
 * toward the low digits and `Math.random()` is not a CSPRNG at all; either one
 * shrinks a 10^6 space that is already the weakest part of this credential.
 */
export function generateLoginCode(): string {
  let code = "";
  for (let index = 0; index < LOGIN_CODE_DIGITS; index += 1) {
    code += String(randomInt(0, 10));
  }
  return code;
}

/**
 * SHA-256 over `${customerId}:${code}`, and the binding is load-bearing.
 *
 * Plain SHA-256 is right here for the same reason it is right for refresh
 * tokens — there is no dictionary attack worth mounting against a value an
 * attacker can simply guess 10^6 ways, and the attempt cap is what bounds that.
 * What the customer id buys is different: it makes two customers holding the
 * same live code impossible to confuse, and it makes a code useless against any
 * account but the one it was issued to, even if the digests were compared by
 * hash alone somewhere downstream.
 */
export function hashLoginCode(customerId: string, code: string): string {
  return createHash("sha256").update(`${customerId}:${code}`, "utf8").digest("hex");
}

/**
 * Constant-time digest comparison.
 *
 * Both sides are our own 32-byte digests, so a byte-by-byte `===` would leak
 * how many leading bytes matched. That is not enough to walk a code on its own,
 * but the whole point of hashing at rest is that a comparison never becomes a
 * side channel.
 */
function digestsMatch(stored: string, candidate: string): boolean {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(candidate, "hex");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Maps the credential-bearing internal record onto the public contract shape.
 *
 * This is the ONLY function that produces a serialisable customer, and it
 * builds the object field by field rather than spreading. A spread would mean
 * that adding `passwordHash` or `totpSecret` to `AuthCustomer` later silently
 * publishes it through every endpoint.
 */
export function toPublicCustomer(customer: AuthCustomer): Customer {
  return {
    id: customer.id,
    email: customer.email,
    emailVerifiedAt: customer.emailVerifiedAt?.toISOString() ?? null,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    role: customer.role,
    twoFactorEnabled: customer.totpEnabledAt !== null,
    anonymisedAt: customer.anonymisedAt?.toISOString() ?? null,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
}

export function serialiseTokens(tokens: TokenPair): {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
} {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    sessionId: tokens.sessionId,
  };
}

/** Re-exported for the guards, which need the same role vocabulary. */
export type { Role };
