import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN_PURPOSES } from "./auth.types";
import type {
  AuthCustomer,
  AuthLogger,
  AuthTokenPurpose,
  AuthTokenRecord,
  EmailOtpRecord,
  RefreshTokenRecord,
  RequestContext,
  SessionRecord,
} from "./auth.types";
import type { AuthRepository } from "./auth.repository";
import { DuplicateEmailError } from "./auth.errors";
import { AUTH_RATE_LIMITS, DEFAULT_AUTH_POLICY, type AuthPolicy } from "./auth.policy";
import { AuthService } from "./auth.service";
import { AccessTokenService } from "./crypto/access-token.service";
import { base32Encode, DEFAULT_TOTP_OPTIONS, TotpService } from "./crypto/totp.service";
import { hashRecoveryCode } from "./crypto/opaque-token";
import { deriveEncryptionKey, seal } from "./crypto/secret-box";
import type { Clock } from "./ports/clock.port";
import { InMemoryAuthEventPublisher } from "./ports/auth-events.port";
import {
  InMemoryAuthRateLimiter,
  type AuthRateLimiter,
  type RateLimitDecision,
} from "./ports/rate-limiter.port";
import type { PasswordHasher } from "./ports/password-hasher.port";

/**
 * Security-boundary tests for AuthService.
 *
 * Every assertion here is about a rule that must not regress, and the whole
 * suite runs with no database, no sleeping and no module mocking — which is the
 * entire reason AuthService depends on `AuthRepository` and `Clock` rather than
 * on Prisma and `Date.now()`.
 */

const ROOT_SECRET = "a-test-root-secret-of-32-plus-characters!";
const CONTEXT: RequestContext = { ipAddress: "203.0.113.7", userAgent: "vitest" };

/**
 * A deliberately trivial hasher. The REAL KDF is verified in
 * scrypt-password-hasher.test.ts; using it here would add ~60ms per login to a
 * suite that performs dozens, and would test nothing this file is about.
 */
class FakeHasher implements PasswordHasher {
  hash(plaintext: string): Promise<string> {
    return Promise.resolve(`fake:${plaintext}`);
  }
  verify(storedHash: string, plaintext: string): Promise<boolean> {
    return Promise.resolve(
      storedHash === `fake:${plaintext}` || storedHash === `legacy:${plaintext}`,
    );
  }
  needsRehash(storedHash: string): boolean {
    return storedHash.startsWith("legacy:");
  }
}

interface RecoveryCodeRow {
  customerId: string;
  codeHash: string;
  usedAt: Date | null;
}

/**
 * In-memory AuthRepository.
 *
 * The three `consume*` methods reproduce the CONDITIONAL-WRITE contract the
 * interface documents: they check-and-set in one synchronous step and report
 * whether they were the one that won. That is what makes the replay and
 * single-use tests meaningful rather than a simulation of a weaker store.
 */
class InMemoryAuthRepository implements AuthRepository {
  readonly customers = new Map<string, AuthCustomer>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  readonly authTokens = new Map<string, AuthTokenRecord>();
  readonly emailOtps = new Map<string, EmailOtpRecord>();
  recoveryCodes: RecoveryCodeRow[] = [];

  /**
   * Every customer id `findEmailOtp` was called with.
   *
   * This is how the anti-enumeration test observes the BURN: an unknown address
   * must still cost one read against `email_otp`, or the request path is
   * measurably faster for addresses that do not exist.
   */
  readonly emailOtpReads: string[] = [];

  constructor(private readonly clock: Clock) {}

  seedCustomer(overrides: Partial<AuthCustomer> = {}): AuthCustomer {
    const now = this.clock.now();
    const customer: AuthCustomer = {
      id: randomUUID(),
      email: "cliente@akai.shop",
      passwordHash: "fake:correct-horse-battery-staple",
      emailVerifiedAt: now,
      firstName: "Ana",
      lastName: "Mestra",
      phone: null,
      role: "CUSTOMER",
      preferredLocale: "es",
      totpSecret: null,
      totpEnabledAt: null,
      anonymisedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      marketingConsentAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  private patchCustomer(id: string, patch: Partial<AuthCustomer>): void {
    const existing = this.customers.get(id);
    if (existing !== undefined) {
      this.customers.set(id, { ...existing, ...patch });
    }
  }

  findCustomerByEmail(email: string): Promise<AuthCustomer | null> {
    for (const customer of this.customers.values()) {
      if (customer.email.toLowerCase() === email.toLowerCase()) {
        return Promise.resolve(customer);
      }
    }
    return Promise.resolve(null);
  }

  findCustomerById(id: string): Promise<AuthCustomer | null> {
    return Promise.resolve(this.customers.get(id) ?? null);
  }

  createCustomer(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly preferredLocale: "es" | "en";
    readonly marketingConsentAt: Date | null;
  }): Promise<AuthCustomer> {
    for (const customer of this.customers.values()) {
      if (customer.email.toLowerCase() === input.email.toLowerCase()) {
        return Promise.reject(new DuplicateEmailError());
      }
    }
    return Promise.resolve(
      this.seedCustomer({
        email: input.email,
        passwordHash: input.passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        preferredLocale: input.preferredLocale,
        marketingConsentAt: input.marketingConsentAt,
        emailVerifiedAt: null,
      }),
    );
  }

  updatePasswordHash(customerId: string, passwordHash: string): Promise<void> {
    this.patchCustomer(customerId, { passwordHash });
    return Promise.resolve();
  }

  recordFailedLogin(customerId: string, lockedUntil: Date | null): Promise<void> {
    const existing = this.customers.get(customerId);
    if (existing !== undefined) {
      this.patchCustomer(customerId, {
        failedLoginCount: existing.failedLoginCount + 1,
        lockedUntil,
      });
    }
    return Promise.resolve();
  }

  clearFailedLogins(customerId: string): Promise<void> {
    this.patchCustomer(customerId, { failedLoginCount: 0, lockedUntil: null });
    return Promise.resolve();
  }

  markEmailVerified(customerId: string, verifiedAt: Date): Promise<void> {
    this.patchCustomer(customerId, { emailVerifiedAt: verifiedAt });
    return Promise.resolve();
  }

  setTotpSecret(
    customerId: string,
    sealedSecret: string | null,
    enabledAt: Date | null,
  ): Promise<void> {
    this.patchCustomer(customerId, { totpSecret: sealedSecret, totpEnabledAt: enabledAt });
    return Promise.resolve();
  }

  createSession(input: {
    readonly customerId: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly expiresAt: Date;
    readonly twoFactorAssertedAt: Date | null;
  }): Promise<SessionRecord> {
    const now = this.clock.now();
    const session: SessionRecord = {
      id: randomUUID(),
      customerId: input.customerId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      twoFactorAssertedAt: input.twoFactorAssertedAt,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.set(session.id, session);
    return Promise.resolve(session);
  }

  findSessionById(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  listActiveSessions(customerId: string, now: Date): Promise<readonly SessionRecord[]> {
    return Promise.resolve(
      [...this.sessions.values()].filter(
        (session) =>
          session.customerId === customerId &&
          session.revokedAt === null &&
          session.expiresAt.getTime() > now.getTime(),
      ),
    );
  }

  touchSession(id: string, lastSeenAt: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session !== undefined) {
      this.sessions.set(id, { ...session, lastSeenAt });
    }
    return Promise.resolve();
  }

  revokeSession(id: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session !== undefined && session.revokedAt === null) {
      this.sessions.set(id, { ...session, revokedAt });
    }
    return Promise.resolve();
  }

  revokeAllSessions(
    customerId: string,
    revokedAt: Date,
    exceptSessionId: string | null,
  ): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (
        session.customerId === customerId &&
        session.revokedAt === null &&
        id !== exceptSessionId
      ) {
        this.sessions.set(id, { ...session, revokedAt });
      }
    }
    return Promise.resolve();
  }

  markTwoFactorAsserted(sessionId: string, assertedAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      this.sessions.set(sessionId, { ...session, twoFactorAssertedAt: assertedAt });
    }
    return Promise.resolve();
  }

  createRefreshToken(input: {
    readonly customerId: string;
    readonly sessionId: string;
    readonly familyId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      id: randomUUID(),
      customerId: input.customerId,
      sessionId: input.sessionId,
      familyId: input.familyId,
      tokenHash: input.tokenHash,
      consumedAt: null,
      revokedAt: null,
      expiresAt: input.expiresAt,
      createdAt: this.clock.now(),
    };
    this.refreshTokens.set(record.id, record);
    return Promise.resolve(record);
  }

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    for (const record of this.refreshTokens.values()) {
      if (record.tokenHash === tokenHash) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(null);
  }

  consumeRefreshToken(id: string, consumedAt: Date): Promise<boolean> {
    const record = this.refreshTokens.get(id);
    // The conditional write: only the caller that observes `consumedAt: null`
    // wins, exactly as `UPDATE ... WHERE consumed_at IS NULL` behaves.
    if (record === undefined || record.consumedAt !== null) {
      return Promise.resolve(false);
    }
    this.refreshTokens.set(id, { ...record, consumedAt });
    return Promise.resolve(true);
  }

  revokeRefreshTokenFamily(familyId: string, revokedAt: Date): Promise<void> {
    for (const [id, record] of this.refreshTokens) {
      if (record.familyId === familyId && record.revokedAt === null) {
        this.refreshTokens.set(id, { ...record, revokedAt });
      }
    }
    return Promise.resolve();
  }

  revokeAllRefreshTokens(customerId: string, revokedAt: Date): Promise<void> {
    for (const [id, record] of this.refreshTokens) {
      if (record.customerId === customerId && record.revokedAt === null) {
        this.refreshTokens.set(id, { ...record, revokedAt });
      }
    }
    return Promise.resolve();
  }

  createAuthToken(input: {
    readonly customerId: string;
    readonly purpose: AuthTokenPurpose;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AuthTokenRecord> {
    const record: AuthTokenRecord = {
      id: randomUUID(),
      customerId: input.customerId,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      usedAt: null,
      expiresAt: input.expiresAt,
      createdAt: this.clock.now(),
    };
    this.authTokens.set(record.id, record);
    return Promise.resolve(record);
  }

  findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRecord | null> {
    for (const record of this.authTokens.values()) {
      if (record.tokenHash === tokenHash) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(null);
  }

  consumeAuthToken(id: string, usedAt: Date): Promise<boolean> {
    const record = this.authTokens.get(id);
    if (record === undefined || record.usedAt !== null) {
      return Promise.resolve(false);
    }
    this.authTokens.set(id, { ...record, usedAt });
    return Promise.resolve(true);
  }

  invalidateAuthTokens(
    customerId: string,
    purpose: AuthTokenPurpose,
    usedAt: Date,
  ): Promise<void> {
    for (const [id, record] of this.authTokens) {
      if (
        record.customerId === customerId &&
        record.purpose === purpose &&
        record.usedAt === null
      ) {
        this.authTokens.set(id, { ...record, usedAt });
      }
    }
    return Promise.resolve();
  }

  replaceRecoveryCodes(customerId: string, codeHashes: readonly string[]): Promise<void> {
    this.recoveryCodes = this.recoveryCodes.filter((row) => row.customerId !== customerId);
    for (const codeHash of codeHashes) {
      this.recoveryCodes.push({ customerId, codeHash, usedAt: null });
    }
    return Promise.resolve();
  }

  consumeRecoveryCode(
    customerId: string,
    codeHash: string,
    usedAt: Date,
  ): Promise<boolean> {
    const row = this.recoveryCodes.find(
      (candidate) =>
        candidate.customerId === customerId &&
        candidate.codeHash === codeHash &&
        candidate.usedAt === null,
    );
    if (row === undefined) {
      return Promise.resolve(false);
    }
    row.usedAt = usedAt;
    return Promise.resolve(true);
  }

  countUnusedRecoveryCodes(customerId: string): Promise<number> {
    return Promise.resolve(
      this.recoveryCodes.filter(
        (row) => row.customerId === customerId && row.usedAt === null,
      ).length,
    );
  }

  // --- emailed one-time sign-in codes --------------------------------------

  upsertEmailOtp(input: {
    readonly customerId: string;
    readonly codeHash: string;
    readonly expiresAt: Date;
  }): Promise<EmailOtpRecord> {
    // The PRIMARY KEY is the customer, so this replaces rather than inserts —
    // one live code per customer, with no application-level "delete the old one
    // first" that a concurrent request could interleave with.
    const record: EmailOtpRecord = {
      customerId: input.customerId,
      codeHash: input.codeHash,
      attempts: 0,
      consumedAt: null,
      expiresAt: input.expiresAt,
      createdAt: this.clock.now(),
    };
    this.emailOtps.set(record.customerId, record);
    return Promise.resolve(record);
  }

  findEmailOtp(customerId: string): Promise<EmailOtpRecord | null> {
    this.emailOtpReads.push(customerId);
    return Promise.resolve(this.emailOtps.get(customerId) ?? null);
  }

  consumeEmailOtp(
    customerId: string,
    codeHash: string,
    consumedAt: Date,
  ): Promise<boolean> {
    const record = this.emailOtps.get(customerId);
    // The conditional write, matching `UPDATE ... WHERE "codeHash" = $1 AND
    // "consumedAt" IS NULL AND "expiresAt" > $2`.
    if (
      record === undefined ||
      record.codeHash !== codeHash ||
      record.consumedAt !== null ||
      record.expiresAt.getTime() <= consumedAt.getTime()
    ) {
      return Promise.resolve(false);
    }
    this.emailOtps.set(customerId, { ...record, consumedAt });
    return Promise.resolve(true);
  }

  recordEmailOtpAttempt(customerId: string): Promise<number | null> {
    const record = this.emailOtps.get(customerId);
    if (record === undefined) {
      return Promise.resolve(null);
    }
    const attempts = record.attempts + 1;
    this.emailOtps.set(customerId, { ...record, attempts });
    return Promise.resolve(attempts);
  }

  deleteEmailOtp(customerId: string): Promise<void> {
    this.emailOtps.delete(customerId);
    return Promise.resolve();
  }
}

interface Harness {
  service: AuthService;
  repository: InMemoryAuthRepository;
  events: InMemoryAuthEventPublisher;
  limiter: AuthRateLimiter;
  clock: Clock;
  advance(ms: number): void;
  setNow(date: Date): void;
  totp: TotpService;
}

const START = new Date("2026-07-20T12:00:00.000Z");

function buildHarness(
  policyOverrides: Partial<AuthPolicy> = {},
  limiterOverride?: AuthRateLimiter,
): Harness {
  let now = new Date(START);
  const clock: Clock = { now: () => new Date(now) };

  const repository = new InMemoryAuthRepository(clock);
  const events = new InMemoryAuthEventPublisher();
  const policy: AuthPolicy = { ...DEFAULT_AUTH_POLICY, ...policyOverrides };

  const logger: AuthLogger = {
    warn: () => undefined,
    error: () => undefined,
  };

  const accessTokens = new AccessTokenService(
    {
      secret: "an-access-token-secret-of-32-plus-chars!!",
      ttlMs: 15 * 60 * 1000,
      issuer: "akai-api",
      audience: "akai-dashboard",
      clockToleranceSeconds: 30,
    },
    clock,
  );

  const totp = new TotpService(DEFAULT_TOTP_OPTIONS, clock);

  // The REAL fixed-window limiter, not a stub: the point of these tests is the
  // key SHAPE (one bucket per address), and a stub that records calls would
  // assert the implementation rather than the behaviour.
  const limiter = limiterOverride ?? new InMemoryAuthRateLimiter(clock);

  const service = new AuthService(
    repository,
    new FakeHasher(),
    events,
    policy,
    clock,
    30 * 24 * 60 * 60 * 1000,
    { totpEncryptionRootSecret: ROOT_SECRET },
    logger,
    accessTokens,
    totp,
    limiter,
  );

  return {
    service,
    repository,
    events,
    limiter,
    clock,
    totp,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setNow: (date: Date) => {
      now = new Date(date);
    },
  };
}

const PASSWORD = "correct-horse-battery-staple";

async function loginOk(harness: Harness, email = "cliente@akai.shop") {
  const result = await harness.service.login(
    { email, password: PASSWORD },
    CONTEXT,
  );
  if (result.requiresTwoFactor) {
    throw new Error("expected a completed login, got a 2FA challenge");
  }
  return result;
}

// ---------------------------------------------------------------------------

describe("register", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const input = {
    email: "nuevo@akai.shop",
    password: "a-sufficiently-long-password",
    firstName: "Ana",
    lastName: "Mestra",
    preferredLocale: "es" as const,
    marketingConsent: false,
  };

  it("creates a customer and emits a registration event carrying the token", async () => {
    const result = await harness.service.register(input);

    expect(result).toEqual({ status: "accepted" });
    expect(harness.repository.customers.size).toBe(1);

    const emitted = harness.events.eventsOfType("auth.customer.registered");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.email).toBe("nuevo@akai.shop");
    expect(emitted[0]?.verificationToken).toBeTruthy();
  });

  it("stores only a hash — never the password", async () => {
    await harness.service.register(input);
    const [customer] = [...harness.repository.customers.values()];
    expect(customer?.passwordHash).toBe(`fake:${input.password}`);
    expect(customer?.passwordHash).not.toBe(input.password);
  });

  it("never assigns a role from the request; new accounts are CUSTOMER", async () => {
    await harness.service.register(input);
    const [customer] = [...harness.repository.customers.values()];
    expect(customer?.role).toBe("CUSTOMER");
  });

  it("leaves a new account unverified", async () => {
    await harness.service.register(input);
    const [customer] = [...harness.repository.customers.values()];
    expect(customer?.emailVerifiedAt).toBeNull();
  });

  // --- enumeration resistance ---------------------------------------------

  it("returns an IDENTICAL response for an address that already exists", async () => {
    harness.repository.seedCustomer({ email: "nuevo@akai.shop" });

    const result = await harness.service.register(input);

    // Byte-identical to the success response. Any difference — status, shape,
    // a message — turns this endpoint into an account-existence oracle.
    expect(result).toEqual({ status: "accepted" });
    expect(harness.repository.customers.size).toBe(1);
  });

  it("notifies the real owner instead of creating a duplicate", async () => {
    harness.repository.seedCustomer({ email: "nuevo@akai.shop" });
    await harness.service.register(input);

    expect(harness.events.eventsOfType("auth.registration.duplicate_attempt")).toHaveLength(1);
    // Critically, NO verification token is minted for the attacker.
    expect(harness.events.eventsOfType("auth.customer.registered")).toHaveLength(0);
  });

  it("swallows a concurrent-signup unique violation into the same neutral response", async () => {
    // The pre-check passes, then the unique index rejects the insert. The
    // response must still be indistinguishable.
    const racing = buildHarness();
    await racing.service.register(input);
    const result = await racing.service.register(input);
    expect(result).toEqual({ status: "accepted" });
  });
});

describe("login", () => {
  let harness: Harness;
  let customer: AuthCustomer;

  beforeEach(() => {
    harness = buildHarness();
    customer = harness.repository.seedCustomer();
  });

  it("issues a token pair and returns the public customer", async () => {
    const result = await loginOk(harness);

    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
    expect(result.customer.id).toBe(customer.id);
  });

  it("never returns credential material in the customer object", async () => {
    const result = await loginOk(harness);
    const serialised = JSON.stringify(result.customer);

    // toPublicCustomer builds field-by-field rather than spreading, which is
    // what makes this hold as AuthCustomer grows.
    expect(serialised).not.toContain("passwordHash");
    expect(serialised).not.toContain("totpSecret");
    expect(serialised).not.toContain(PASSWORD);
  });

  it("stores only the HASH of the refresh token", async () => {
    const result = await loginOk(harness);
    const [record] = [...harness.repository.refreshTokens.values()];

    expect(record).toBeDefined();
    expect(record?.tokenHash).not.toBe(result.tokens.refreshToken);
    expect(record?.tokenHash).toHaveLength(64);
  });

  it("rejects a wrong password and an unknown address IDENTICALLY", async () => {
    const wrongPassword = await harness.service
      .login({ email: customer.email, password: "not-the-password" }, CONTEXT)
      .catch((error: unknown) => error);

    const unknownAccount = await harness.service
      .login({ email: "nobody@akai.shop", password: PASSWORD }, CONTEXT)
      .catch((error: unknown) => error);

    expect(wrongPassword).toBeInstanceOf(Error);
    expect(unknownAccount).toBeInstanceOf(Error);
    // Same class AND same message. A different message for either case is a
    // working account-enumeration oracle.
    expect((wrongPassword as Error).message).toBe((unknownAccount as Error).message);
    expect((wrongPassword as Error).constructor).toBe(
      (unknownAccount as Error).constructor,
    );
  });

  it("verifies a dummy hash for an unknown account so timing does not enumerate", async () => {
    let verifyCalls = 0;
    const counting = buildHarness();
    // Replace the hasher with one that counts verifications.
    const service = new AuthService(
      counting.repository,
      {
        hash: (plaintext: string) => Promise.resolve(`fake:${plaintext}`),
        verify: (): Promise<boolean> => {
          verifyCalls += 1;
          return Promise.resolve(false);
        },
        needsRehash: () => false,
      },
      counting.events,
      DEFAULT_AUTH_POLICY,
      counting.clock,
      1000,
      { totpEncryptionRootSecret: ROOT_SECRET },
      { warn: () => undefined, error: () => undefined },
      new AccessTokenService(
        {
          secret: "an-access-token-secret-of-32-plus-chars!!",
          ttlMs: 60_000,
          issuer: "akai-api",
          audience: "akai-dashboard",
          clockToleranceSeconds: 30,
        },
        counting.clock,
      ),
      new TotpService(DEFAULT_TOTP_OPTIONS, counting.clock),
      counting.limiter,
    );

    await service
      .login({ email: "nobody@akai.shop", password: PASSWORD }, CONTEXT)
      .catch(() => undefined);

    // A short-circuit return would leave this at 0 and make "no such account"
    // measurably faster than "wrong password".
    expect(verifyCalls).toBe(1);
  });

  it("refuses an anonymised account", async () => {
    harness.repository.seedCustomer({
      email: "borrado@akai.shop",
      anonymisedAt: new Date(START),
    });

    await expect(
      harness.service.login({ email: "borrado@akai.shop", password: PASSWORD }, CONTEXT),
    ).rejects.toThrow();
  });

  it("refuses an account with no password (guest-checkout shell record)", async () => {
    harness.repository.seedCustomer({
      email: "invitado@akai.shop",
      passwordHash: null,
    });

    await expect(
      harness.service.login({ email: "invitado@akai.shop", password: PASSWORD }, CONTEXT),
    ).rejects.toThrow();
  });

  it("upgrades a legacy hash on a successful login", async () => {
    harness.repository.seedCustomer({
      email: "antiguo@akai.shop",
      passwordHash: `legacy:${PASSWORD}`,
    });

    await loginOk(harness, "antiguo@akai.shop");

    const updated = await harness.repository.findCustomerByEmail("antiguo@akai.shop");
    expect(updated?.passwordHash).toBe(`fake:${PASSWORD}`);
  });
});

describe("login — account lockout", () => {
  let harness: Harness;
  let customer: AuthCustomer;

  beforeEach(() => {
    harness = buildHarness({ maxFailedLogins: 5, lockoutMs: 15 * 60 * 1000 });
    customer = harness.repository.seedCustomer();
  });

  async function failLogin(): Promise<void> {
    await harness.service
      .login({ email: customer.email, password: "wrong" }, CONTEXT)
      .catch(() => undefined);
  }

  it("counts failures without locking below the threshold", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await failLogin();
    }

    const stored = await harness.repository.findCustomerById(customer.id);
    expect(stored?.failedLoginCount).toBe(4);
    expect(stored?.lockedUntil).toBeNull();

    // The 4th failure must NOT lock: a boundary set one too low locks
    // legitimate users out routinely.
    await expect(loginOk(harness)).resolves.toBeDefined();
  });

  it("locks the account on the configured failure and emits an event", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await failLogin();
    }

    const stored = await harness.repository.findCustomerById(customer.id);
    expect(stored?.lockedUntil).not.toBeNull();
    expect(harness.events.eventsOfType("auth.account.locked")).toHaveLength(1);
  });

  it("refuses the CORRECT password while locked", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await failLogin();
    }

    // This is the whole point of a lockout: knowing the password is not enough
    // once the account is under attack.
    await expect(loginOk(harness)).rejects.toThrow();
  });

  it("lets the account back in once the lockout expires", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await failLogin();
    }

    harness.advance(15 * 60 * 1000 + 1);
    await expect(loginOk(harness)).resolves.toBeDefined();
  });

  it("clears the counter on a successful login", async () => {
    await failLogin();
    await failLogin();
    await loginOk(harness);

    const stored = await harness.repository.findCustomerById(customer.id);
    expect(stored?.failedLoginCount).toBe(0);
    expect(stored?.lockedUntil).toBeNull();
  });
});

describe("login — two-factor", () => {
  let harness: Harness;
  let customer: AuthCustomer;
  const SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  beforeEach(() => {
    harness = buildHarness();
    customer = harness.repository.seedCustomer({
      totpSecret: seal(SECRET, deriveEncryptionKey(ROOT_SECRET)),
      totpEnabledAt: new Date(START),
    });
  });

  it("challenges instead of issuing tokens when no code is supplied", async () => {
    const result = await harness.service.login(
      { email: customer.email, password: PASSWORD },
      CONTEXT,
    );

    expect(result.requiresTwoFactor).toBe(true);
    // No session, no tokens: a correct password alone must buy nothing.
    expect(harness.repository.sessions.size).toBe(0);
    expect(harness.repository.refreshTokens.size).toBe(0);
  });

  it("withholds the customer object during the challenge", async () => {
    const result = await harness.service.login(
      { email: customer.email, password: PASSWORD },
      CONTEXT,
    );

    // Knowing the password must not reveal the account holder's name.
    expect(JSON.stringify(result)).not.toContain("Mestra");
  });

  it("completes the login with a valid TOTP code and marks the session asserted", async () => {
    const code = harness.totp.generate(SECRET, new Date(START));
    const result = await harness.service.login(
      { email: customer.email, password: PASSWORD, totpCode: code ?? "" },
      CONTEXT,
    );

    expect(result.requiresTwoFactor).toBe(false);
    const [session] = [...harness.repository.sessions.values()];
    expect(session?.twoFactorAssertedAt).not.toBeNull();
  });

  it("rejects an invalid TOTP code and counts it as a failed attempt", async () => {
    await expect(
      harness.service.login(
        { email: customer.email, password: PASSWORD, totpCode: "000000" },
        CONTEXT,
      ),
    ).rejects.toThrow();

    const stored = await harness.repository.findCustomerById(customer.id);
    // A second factor that can be brute-forced without consuming the lockout
    // budget is not a second factor.
    expect(stored?.failedLoginCount).toBe(1);
  });

  it("accepts a recovery code exactly once", async () => {
    const code = "ABCDE-FGHIJ";
    await harness.repository.replaceRecoveryCodes(customer.id, [hashRecoveryCode(code)]);

    const first = await harness.service.login(
      { email: customer.email, password: PASSWORD, recoveryCode: code },
      CONTEXT,
    );
    expect(first.requiresTwoFactor).toBe(false);

    // Single use, enforced by the conditional write.
    await expect(
      harness.service.login(
        { email: customer.email, password: PASSWORD, recoveryCode: code },
        CONTEXT,
      ),
    ).rejects.toThrow();
  });

  it("fails closed when the sealed TOTP secret cannot be decrypted", async () => {
    await harness.repository.setTotpSecret(customer.id, "v1.garbage.garbage.garbage", new Date(START));
    const code = harness.totp.generate(SECRET, new Date(START));

    await expect(
      harness.service.login(
        { email: customer.email, password: PASSWORD, totpCode: code ?? "" },
        CONTEXT,
      ),
    ).rejects.toThrow();
  });
});

describe("login — mandatory 2FA for ADMIN", () => {
  let harness: Harness;
  const SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  beforeEach(() => {
    harness = buildHarness();
  });

  it("refuses a correct password when an ADMIN has not enrolled a second factor", async () => {
    const admin = harness.repository.seedCustomer({
      email: "admin@akai.shop",
      role: "ADMIN",
      totpEnabledAt: null,
    });

    await expect(
      harness.service.login({ email: admin.email, password: PASSWORD }, CONTEXT),
    ).rejects.toThrow();

    // Fail closed: no session, no tokens — a password-only admin login must buy
    // nothing at all (spec §8).
    expect(harness.repository.sessions.size).toBe(0);
    expect(harness.repository.refreshTokens.size).toBe(0);
  });

  it("still lets an ADMIN in once TOTP is enrolled and a valid code is supplied", async () => {
    const admin = harness.repository.seedCustomer({
      email: "admin-2fa@akai.shop",
      role: "ADMIN",
      totpSecret: seal(SECRET, deriveEncryptionKey(ROOT_SECRET)),
      totpEnabledAt: new Date(START),
    });

    const code = harness.totp.generate(SECRET, new Date(START));
    const result = await harness.service.login(
      { email: admin.email, password: PASSWORD, totpCode: code ?? "" },
      CONTEXT,
    );

    expect(result.requiresTwoFactor).toBe(false);
  });

  it("does NOT block a CUSTOMER without a second factor", async () => {
    harness.repository.seedCustomer({
      email: "normal@akai.shop",
      role: "CUSTOMER",
      totpEnabledAt: null,
    });

    const result = await harness.service.login(
      { email: "normal@akai.shop", password: PASSWORD },
      CONTEXT,
    );

    expect(result.requiresTwoFactor).toBe(false);
  });
});

describe("refresh — rotation and reuse detection", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
    harness.repository.seedCustomer();
  });

  it("rotates: the old token stops working and a new one is issued", async () => {
    const login = await loginOk(harness);
    const rotated = await harness.service.refresh(login.tokens.refreshToken, CONTEXT);

    expect(rotated.refreshToken).not.toBe(login.tokens.refreshToken);
    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.sessionId).toBe(login.tokens.sessionId);
  });

  /**
   * SLIDING TWO-FACTOR ASSERTION.
   *
   * `RolesGuard` refuses an elevated route when `twoFactorAssertedAt` is older
   * than the freshness window, and rotation now renews it so an admin in active
   * use is never re-prompted. The second test is the one that matters: renewing
   * must never CREATE an assertion, or a password-only session would gain the
   * step-up claim by simply refreshing — a privilege escalation wearing the
   * costume of a convenience.
   */
  it("RENEWS an existing two-factor assertion, so an active admin is not re-prompted", async () => {
    // `SECRET` is block-scoped to the two-factor describes; this block needs its own.
    const totpSecret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    const admin = harness.repository.seedCustomer({
      email: "admin-slide@akai.shop",
      role: "ADMIN",
      totpSecret: seal(totpSecret, deriveEncryptionKey(ROOT_SECRET)),
      totpEnabledAt: new Date(START),
    });

    const code = harness.totp.generate(totpSecret, new Date(START));
    const login = await harness.service.login(
      { email: admin.email, password: PASSWORD, totpCode: code ?? "" },
      CONTEXT,
    );
    if (login.requiresTwoFactor) throw new Error("expected a token pair");

    const before = harness.repository.sessions.get(login.tokens.sessionId)?.twoFactorAssertedAt;
    expect(before).not.toBeNull();

    // Advance well past the 15-minute freshness window, then rotate.
    harness.advance(60 * 60 * 1000);
    await harness.service.refresh(login.tokens.refreshToken, CONTEXT);

    const after = harness.repository.sessions.get(login.tokens.sessionId)?.twoFactorAssertedAt;
    expect(after).not.toBeNull();
    expect(after?.getTime()).toBe(harness.clock.now().getTime());
    expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  it("does NOT create an assertion for a session that never proved a second factor", async () => {
    // A CUSTOMER signs in with a password alone; its assertion is null and must
    // STAY null through any number of rotations.
    const login = await loginOk(harness);
    expect(harness.repository.sessions.get(login.tokens.sessionId)?.twoFactorAssertedAt).toBeNull();

    harness.advance(60 * 60 * 1000);
    const rotated = await harness.service.refresh(login.tokens.refreshToken, CONTEXT);
    expect(harness.repository.sessions.get(rotated.sessionId)?.twoFactorAssertedAt).toBeNull();
  });

  it("keeps the rotated token inside the same family", async () => {
    const login = await loginOk(harness);
    await harness.service.refresh(login.tokens.refreshToken, CONTEXT);

    const families = new Set(
      [...harness.repository.refreshTokens.values()].map((token) => token.familyId),
    );
    expect(families.size).toBe(1);
  });

  it("REVOKES THE WHOLE FAMILY when a consumed token is replayed", async () => {
    const login = await loginOk(harness);
    const rotated = await harness.service.refresh(login.tokens.refreshToken, CONTEXT);

    // The attacker replays the stolen (already-rotated) token.
    await expect(harness.service.refresh(login.tokens.refreshToken, CONTEXT)).rejects.toThrow();

    // Everything descended from that login is dead, including the token the
    // legitimate user is holding — we cannot tell which party is which, so both
    // are logged out.
    const live = [...harness.repository.refreshTokens.values()].filter(
      (token) => token.revokedAt === null,
    );
    expect(live).toHaveLength(0);

    await expect(harness.service.refresh(rotated.refreshToken, CONTEXT)).rejects.toThrow();
  });

  it("revokes the SESSION too, so the live access token dies immediately", async () => {
    const login = await loginOk(harness);
    await harness.service.refresh(login.tokens.refreshToken, CONTEXT);
    await harness.service.refresh(login.tokens.refreshToken, CONTEXT).catch(() => undefined);

    const session = await harness.repository.findSessionById(login.tokens.sessionId);
    expect(session?.revokedAt).not.toBeNull();

    // Revoking only the refresh family would leave the stolen access token
    // valid for up to its full TTL.
    expect(await harness.service.authenticate(login.tokens.accessToken)).toBeNull();
  });

  it("emits a reuse event for alerting", async () => {
    const login = await loginOk(harness);
    await harness.service.refresh(login.tokens.refreshToken, CONTEXT);
    await harness.service.refresh(login.tokens.refreshToken, CONTEXT).catch(() => undefined);

    expect(harness.events.eventsOfType("auth.refresh_token.reuse_detected")).toHaveLength(1);
  });

  it("rejects an unknown, expired or revoked token", async () => {
    await expect(harness.service.refresh("never-issued", CONTEXT)).rejects.toThrow();

    const login = await loginOk(harness);
    harness.advance(31 * 24 * 60 * 60 * 1000);
    await expect(harness.service.refresh(login.tokens.refreshToken, CONTEXT)).rejects.toThrow();
  });

  it("rejects a valid token whose session has been revoked", async () => {
    const login = await loginOk(harness);
    await harness.repository.revokeSession(login.tokens.sessionId, new Date(START));

    await expect(harness.service.refresh(login.tokens.refreshToken, CONTEXT)).rejects.toThrow();
  });

  it("picks up a role change on rotation", async () => {
    const login = await loginOk(harness);
    const [customer] = [...harness.repository.customers.values()];
    expect(customer).toBeDefined();
    if (customer === undefined) return;

    harness.repository.customers.set(customer.id, { ...customer, role: "ADMIN" });
    const rotated = await harness.service.refresh(login.tokens.refreshToken, CONTEXT);

    const principal = await harness.service.authenticate(rotated.accessToken);
    expect(principal?.role).toBe("ADMIN");
  });
});

describe("authenticate", () => {
  let harness: Harness;
  let customer: AuthCustomer;

  beforeEach(() => {
    harness = buildHarness();
    customer = harness.repository.seedCustomer();
  });

  it("resolves a valid access token to a principal", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);

    expect(principal?.customerId).toBe(customer.id);
    expect(principal?.sessionId).toBe(login.tokens.sessionId);
  });

  it("reads the role from the DATABASE, not from the token claim", async () => {
    const login = await loginOk(harness);

    // Demote the customer AFTER the token was minted with role CUSTOMER... then
    // promote, which is the dangerous direction to get wrong.
    harness.repository.customers.set(customer.id, { ...customer, role: "ADMIN" });
    expect((await harness.service.authenticate(login.tokens.accessToken))?.role).toBe("ADMIN");

    harness.repository.customers.set(customer.id, { ...customer, role: "CUSTOMER" });
    // A revocation must bite on the NEXT request, not when the 15-minute access
    // token happens to expire.
    expect((await harness.service.authenticate(login.tokens.accessToken))?.role).toBe("CUSTOMER");
  });

  it("returns null for a revoked session even though the signature is valid", async () => {
    const login = await loginOk(harness);
    await harness.repository.revokeSession(login.tokens.sessionId, new Date(START));

    expect(await harness.service.authenticate(login.tokens.accessToken)).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const login = await loginOk(harness);
    harness.advance(31 * 24 * 60 * 60 * 1000);

    expect(await harness.service.authenticate(login.tokens.accessToken)).toBeNull();
  });

  it("returns null for an expired access token", async () => {
    const login = await loginOk(harness);
    harness.advance(16 * 60 * 1000);

    expect(await harness.service.authenticate(login.tokens.accessToken)).toBeNull();
  });

  it("returns null for an anonymised customer", async () => {
    const login = await loginOk(harness);
    harness.repository.customers.set(customer.id, {
      ...customer,
      anonymisedAt: new Date(START),
    });

    expect(await harness.service.authenticate(login.tokens.accessToken)).toBeNull();
  });

  it("returns null — never throws — for garbage input", async () => {
    for (const bad of ["", "not.a.token", "a.b.c"]) {
      await expect(harness.service.authenticate(bad)).resolves.toBeNull();
    }
  });
});

describe("email verification", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  async function registerAndGetToken(): Promise<string> {
    await harness.service.register({
      email: "nuevo@akai.shop",
      password: "a-sufficiently-long-password",
      firstName: "Ana",
      lastName: "Mestra",
      preferredLocale: "es",
      marketingConsent: false,
    });
    const event = harness.events.eventsOfType("auth.customer.registered")[0];
    return event?.verificationToken ?? "";
  }

  it("verifies the address and emits a completion event", async () => {
    const token = await registerAndGetToken();
    await harness.service.verifyEmail(token);

    const customer = await harness.repository.findCustomerByEmail("nuevo@akai.shop");
    expect(customer?.emailVerifiedAt).not.toBeNull();
    expect(harness.events.eventsOfType("auth.email_verification.completed")).toHaveLength(1);
  });

  it("is single-use", async () => {
    const token = await registerAndGetToken();
    await harness.service.verifyEmail(token);
    await expect(harness.service.verifyEmail(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await registerAndGetToken();
    harness.advance(DEFAULT_AUTH_POLICY.emailVerificationTtlMs + 1);
    await expect(harness.service.verifyEmail(token)).rejects.toThrow();
  });

  it("rejects an unknown token", async () => {
    await expect(harness.service.verifyEmail("never-issued")).rejects.toThrow();
  });

  it("stores only the hash of the token", async () => {
    const token = await registerAndGetToken();
    const [record] = [...harness.repository.authTokens.values()];
    expect(record?.tokenHash).not.toBe(token);
  });

  it("returns a neutral acknowledgement for a resend to an unknown address", async () => {
    const result = await harness.service.resendVerification("nobody@akai.shop");
    expect(result).toEqual({ status: "accepted" });
    expect(harness.events.eventsOfType("auth.email_verification.requested")).toHaveLength(0);
  });
});

describe("password reset", () => {
  let harness: Harness;
  let customer: AuthCustomer;

  beforeEach(() => {
    harness = buildHarness();
    customer = harness.repository.seedCustomer();
  });

  async function requestToken(): Promise<string> {
    await harness.service.requestPasswordReset(customer.email);
    const event = harness.events.eventsOfType("auth.password_reset.requested")[0];
    return event?.resetToken ?? "";
  }

  it("returns the SAME acknowledgement for a known and an unknown address", async () => {
    const known = await harness.service.requestPasswordReset(customer.email);
    const unknown = await harness.service.requestPasswordReset("nobody@akai.shop");

    expect(known).toEqual(unknown);
    expect(known).toEqual({ status: "accepted" });
    // Only the real address produces an event; the caller cannot tell.
    expect(harness.events.eventsOfType("auth.password_reset.requested")).toHaveLength(1);
  });

  it("sets the new password and lets the user log in with it", async () => {
    const token = await requestToken();
    await harness.service.confirmPasswordReset({ token, password: "a-brand-new-password" });

    await expect(
      harness.service.login({ email: customer.email, password: "a-brand-new-password" }, CONTEXT),
    ).resolves.toBeDefined();
    await expect(
      harness.service.login({ email: customer.email, password: PASSWORD }, CONTEXT),
    ).rejects.toThrow();
  });

  it("destroys every existing session and refresh family", async () => {
    const login = await loginOk(harness);
    const token = await requestToken();

    await harness.service.confirmPasswordReset({ token, password: "a-brand-new-password" });

    // A reset is the response to a suspected compromise. Leaving the attacker's
    // session alive would defeat the entire exercise.
    expect(await harness.service.authenticate(login.tokens.accessToken)).toBeNull();
    await expect(harness.service.refresh(login.tokens.refreshToken, CONTEXT)).rejects.toThrow();
  });

  it("is single-use, and invalidates any other outstanding reset link", async () => {
    const first = await requestToken();
    await harness.service.requestPasswordReset(customer.email);
    const second =
      harness.events.eventsOfType("auth.password_reset.requested")[1]?.resetToken ?? "";

    // Requesting a second link kills the first: a mailbox holding five valid
    // links is five chances for one to leak.
    await expect(
      harness.service.confirmPasswordReset({ token: first, password: "another-long-password" }),
    ).rejects.toThrow();

    await harness.service.confirmPasswordReset({ token: second, password: "another-long-password" });
    await expect(
      harness.service.confirmPasswordReset({ token: second, password: "yet-another-password" }),
    ).rejects.toThrow();
  });

  it("rejects an expired reset token", async () => {
    const token = await requestToken();
    harness.advance(DEFAULT_AUTH_POLICY.passwordResetTtlMs + 1);
    await expect(
      harness.service.confirmPasswordReset({ token, password: "a-brand-new-password" }),
    ).rejects.toThrow();
  });

  it("REFUSES an email-verification token at the reset endpoint", async () => {
    // Purpose confusion is the attack: verification tokens are issued freely
    // and live for 24h. Redeeming one as a password reset would be full account
    // takeover of any address an attacker can trigger a signup for.
    const separate = buildHarness();
    await separate.service.register({
      email: "victima@akai.shop",
      password: "a-sufficiently-long-password",
      firstName: "Ana",
      lastName: "Mestra",
      preferredLocale: "es",
      marketingConsent: false,
    });
    const verificationToken =
      separate.events.eventsOfType("auth.customer.registered")[0]?.verificationToken ?? "";

    await expect(
      separate.service.confirmPasswordReset({
        token: verificationToken,
        password: "attacker-chosen-password",
      }),
    ).rejects.toThrow();
  });

  it("REFUSES a password-reset token at the verification endpoint", async () => {
    const token = await requestToken();
    await expect(harness.service.verifyEmail(token)).rejects.toThrow();
  });

  it("clears an active lockout, so an attacker cannot lock someone out forever", async () => {
    const locked = buildHarness({ maxFailedLogins: 2 });
    const target = locked.repository.seedCustomer();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await locked.service
        .login({ email: target.email, password: "wrong" }, CONTEXT)
        .catch(() => undefined);
    }
    expect((await locked.repository.findCustomerById(target.id))?.lockedUntil).not.toBeNull();

    await locked.service.requestPasswordReset(target.email);
    const token =
      locked.events.eventsOfType("auth.password_reset.requested")[0]?.resetToken ?? "";
    await locked.service.confirmPasswordReset({ token, password: "a-brand-new-password" });

    expect((await locked.repository.findCustomerById(target.id))?.lockedUntil).toBeNull();
  });

  it("marks the address verified — redeeming the link proves mailbox control", async () => {
    const unverified = buildHarness();
    const target = unverified.repository.seedCustomer({ emailVerifiedAt: null });

    await unverified.service.requestPasswordReset(target.email);
    const token =
      unverified.events.eventsOfType("auth.password_reset.requested")[0]?.resetToken ?? "";
    await unverified.service.confirmPasswordReset({ token, password: "a-brand-new-password" });

    expect((await unverified.repository.findCustomerById(target.id))?.emailVerifiedAt).not.toBeNull();
  });
});

describe("change password", () => {
  let harness: Harness;
  let customer: AuthCustomer;

  beforeEach(() => {
    harness = buildHarness();
    customer = harness.repository.seedCustomer();
  });

  it("rejects a wrong current password", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    expect(principal).not.toBeNull();
    if (principal === null) return;

    await expect(
      harness.service.changePassword(principal, {
        currentPassword: "not-the-password",
        newPassword: "a-brand-new-password",
      }),
    ).rejects.toThrow();
  });

  it("rejects reusing the same password", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    if (principal === null) return;

    await expect(
      harness.service.changePassword(principal, {
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      }),
    ).rejects.toThrow();
  });

  it("signs out every OTHER device but keeps the current session alive", async () => {
    const other = await loginOk(harness);
    const current = await loginOk(harness);
    const principal = await harness.service.authenticate(current.tokens.accessToken);
    if (principal === null) return;

    await harness.service.changePassword(principal, {
      currentPassword: PASSWORD,
      newPassword: "a-brand-new-password",
    });

    // The device performing a deliberate rotation should not sign itself out.
    expect(await harness.service.authenticate(current.tokens.accessToken)).not.toBeNull();
    expect(await harness.service.authenticate(other.tokens.accessToken)).toBeNull();

    expect(harness.events.eventsOfType("auth.password.changed")).toHaveLength(1);
    expect(customer.id).toBeTruthy();
  });
});

describe("logout and session management", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
    harness.repository.seedCustomer();
  });

  it("revokes the current session and its refresh family", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    if (principal === null) return;

    await harness.service.logout(principal, {
      refreshToken: login.tokens.refreshToken,
      allDevices: false,
    });

    expect(await harness.service.authenticate(login.tokens.accessToken)).toBeNull();
    await expect(harness.service.refresh(login.tokens.refreshToken, CONTEXT)).rejects.toThrow();
  });

  it("revokes every device when asked", async () => {
    const first = await loginOk(harness);
    const second = await loginOk(harness);
    const principal = await harness.service.authenticate(first.tokens.accessToken);
    if (principal === null) return;

    await harness.service.logout(principal, { allDevices: true });

    expect(await harness.service.authenticate(first.tokens.accessToken)).toBeNull();
    expect(await harness.service.authenticate(second.tokens.accessToken)).toBeNull();
  });

  it("will NOT revoke a refresh family belonging to another customer", async () => {
    const victim = harness.repository.seedCustomer({ email: "victima@akai.shop" });
    const victimLogin = await loginOk(harness, victim.email);

    const attackerLogin = await loginOk(harness);
    const attacker = await harness.service.authenticate(attackerLogin.tokens.accessToken);
    if (attacker === null) return;

    // The attacker presents a token they somehow obtained but do not own.
    await harness.service.logout(attacker, {
      refreshToken: victimLogin.tokens.refreshToken,
      allDevices: false,
    });

    // Ownership is checked before revoking, so this is not a denial-of-service
    // primitive against arbitrary accounts.
    await expect(
      harness.service.refresh(victimLogin.tokens.refreshToken, CONTEXT),
    ).resolves.toBeDefined();
  });

  it("lists only this customer's active sessions and flags the current one", async () => {
    const login = await loginOk(harness);
    await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    if (principal === null) return;

    const sessions = await harness.service.listSessions(principal);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.customerId === principal.customerId)).toBe(true);
  });

  it("does not let a customer revoke a stranger's session", async () => {
    const victim = harness.repository.seedCustomer({ email: "victima@akai.shop" });
    const victimLogin = await loginOk(harness, victim.email);

    const attackerLogin = await loginOk(harness);
    const attacker = await harness.service.authenticate(attackerLogin.tokens.accessToken);
    if (attacker === null) return;

    const result = await harness.service.revokeSession(attacker, victimLogin.tokens.sessionId);

    // Returns the neutral acknowledgement (not a 403, which would confirm the
    // session id exists) while leaving the victim's session untouched.
    expect(result).toEqual({ status: "accepted" });
    expect(await harness.service.authenticate(victimLogin.tokens.accessToken)).not.toBeNull();
  });
});

describe("two-factor enrolment", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
    harness.repository.seedCustomer();
  });

  it("does not persist anything until the code is confirmed", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    if (principal === null) return;

    const enrolment = await harness.service.beginTotpEnrolment(principal);
    expect(enrolment.secret).toBeTruthy();
    expect(enrolment.keyUri).toContain("otpauth://totp/");

    // Half-enrolling an ADMIN would lock them out of the admin surface with no
    // way back.
    const stored = await harness.repository.findCustomerById(principal.customerId);
    expect(stored?.totpSecret).toBeNull();
    expect(stored?.totpEnabledAt).toBeNull();
  });

  it("rejects a wrong confirmation code", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    if (principal === null) return;

    const enrolment = await harness.service.beginTotpEnrolment(principal);
    await expect(
      harness.service.confirmTotpEnrolment(principal, {
        secret: enrolment.secret,
        code: "000000",
      }),
    ).rejects.toThrow();
  });

  it("stores the secret SEALED and returns ten recovery codes exactly once", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    if (principal === null) return;

    const enrolment = await harness.service.beginTotpEnrolment(principal);
    const code = harness.totp.generate(enrolment.secret, new Date(START)) ?? "";
    const result = await harness.service.confirmTotpEnrolment(principal, {
      secret: enrolment.secret,
      code,
    });

    expect(result.recoveryCodes).toHaveLength(10);

    const stored = await harness.repository.findCustomerById(principal.customerId);
    expect(stored?.totpEnabledAt).not.toBeNull();
    // Encrypted at rest — the raw base32 secret must not be in the column.
    expect(stored?.totpSecret).not.toBe(enrolment.secret);
    expect(stored?.totpSecret?.startsWith("v1.")).toBe(true);

    // Only hashes are kept, so no endpoint can ever show these again.
    for (const recovery of result.recoveryCodes) {
      expect(
        harness.repository.recoveryCodes.some((row) => row.codeHash === recovery),
      ).toBe(false);
    }
    expect(await harness.repository.countUnusedRecoveryCodes(principal.customerId)).toBe(10);

    expect(harness.events.eventsOfType("auth.two_factor.enabled")).toHaveLength(1);
  });

  it("requires the password to disable", async () => {
    const login = await loginOk(harness);
    const principal = await harness.service.authenticate(login.tokens.accessToken);
    if (principal === null) return;

    await expect(
      harness.service.disableTotp(principal, { password: "not-the-password" }),
    ).rejects.toThrow();

    // Possession of an unlocked session is not enough to remove a second factor.
    await expect(
      harness.service.disableTotp(principal, { password: PASSWORD }),
    ).resolves.toEqual({ status: "accepted" });
  });
});

describe("auth token purposes", () => {
  it("pins the purpose vocabulary shared with the AuthToken table", () => {
    // The column is a VarChar, not a Prisma enum, so this constant is the only
    // thing keeping the two flows from drifting into each other.
    expect(AUTH_TOKEN_PURPOSES).toEqual(["EMAIL_VERIFICATION", "PASSWORD_RESET"]);
  });
});

// ---------------------------------------------------------------------------
// Per-email rate limiting
// ---------------------------------------------------------------------------

/**
 * These live at the SERVICE layer, not on a guard, and that is the whole point.
 *
 * `AuthRateLimitGuard` keys on the socket address with Express `trust proxy`
 * deliberately unset — and every customer reaches this API through the Next BFF
 * route handlers, so the socket address is the STOREFRONT CONTAINER's for all of
 * them. Installing that guard puts the entire user base in one bucket: the
 * shared `refresh` budget signs everyone out and the exhausted `login` budget
 * stops them signing back in. A global auth lockout is strictly worse than no
 * limit, which is why the guard installation was reverted and why the budget is
 * enforced here, where the request body — and therefore the address — is visible.
 *
 * The "a DIFFERENT address is unaffected" assertion in each test below is the
 * one that would have caught that.
 */

function statusOf(error: unknown): number | null {
  return error instanceof HttpException ? error.getStatus() : null;
}

async function loginStatus(
  harness: Harness,
  email: string,
  password = "wrong-password",
): Promise<number | null> {
  return harness.service
    .login({ email, password }, CONTEXT)
    .then(() => 200)
    .catch((error: unknown) => statusOf(error));
}

describe("per-email rate limiting", () => {
  const BUDGET = AUTH_RATE_LIMITS.login.limit;

  it("refuses a spent per-email login budget while leaving a DIFFERENT address untouched", async () => {
    const harness = buildHarness();

    // Unknown addresses on purpose: this isolates the limiter from the durable
    // account lockout, which is a separate control on a separate counter.
    for (let attempt = 0; attempt < BUDGET; attempt += 1) {
      expect(await loginStatus(harness, "victima@akai.shop")).toBe(401);
    }

    expect(await loginStatus(harness, "victima@akai.shop")).toBe(429);

    // THE regression test. If this is 429, every caller shares one bucket and
    // the platform has a global sign-in outage the moment anyone is throttled.
    expect(await loginStatus(harness, "otra@akai.shop")).toBe(401);
  });

  it("throttles an address that does not exist exactly as one that does", async () => {
    const harness = buildHarness();
    harness.repository.seedCustomer({ email: "existe@akai.shop" });

    for (let attempt = 0; attempt < BUDGET; attempt += 1) {
      await loginStatus(harness, "existe@akai.shop");
      await loginStatus(harness, "nadie@akai.shop");
    }

    // A limiter that only counted for real accounts would answer 429 here and
    // 401 below — a working account-existence oracle, defeating the identical
    // `invalidCredentials()` the rest of the module is built around.
    expect(await loginStatus(harness, "existe@akai.shop")).toBe(429);
    expect(await loginStatus(harness, "nadie@akai.shop")).toBe(429);
  });

  it("folds case and surrounding whitespace into ONE bucket", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < BUDGET; attempt += 1) {
      await loginStatus(harness, "Mixta@Akai.shop");
    }

    // The column is citext, so these are the same account. If they were
    // different buckets an attacker would get an unlimited budget for free.
    expect(await loginStatus(harness, "mixta@akai.shop")).toBe(429);
    expect(await loginStatus(harness, "  MIXTA@akai.shop  ")).toBe(429);
  });

  it("forgives the burst once the real owner signs in", async () => {
    const harness = buildHarness();
    const customer = harness.repository.seedCustomer({ email: "dueno@akai.shop" });

    for (let attempt = 0; attempt < BUDGET - 1; attempt += 1) {
      expect(await loginStatus(harness, customer.email)).toBe(401);
    }

    expect(await loginStatus(harness, customer.email, PASSWORD)).toBe(200);

    // Without the reset the owner would be one attempt from locking themselves
    // out of their own account after a typo streak.
    expect(await loginStatus(harness, customer.email)).toBe(401);
  });

  it("opens the window again once it lapses", async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < BUDGET; attempt += 1) {
      await loginStatus(harness, "ventana@akai.shop");
    }
    expect(await loginStatus(harness, "ventana@akai.shop")).toBe(429);

    harness.advance(AUTH_RATE_LIMITS.login.windowMs + 1);
    expect(await loginStatus(harness, "ventana@akai.shop")).toBe(401);
  });

  it("FAILS OPEN when the limiter store is unavailable", async () => {
    const broken: AuthRateLimiter = {
      consume: (): Promise<RateLimitDecision> =>
        Promise.reject(new Error("rate_limit_counter is unreachable")),
      reset: (): Promise<void> => Promise.reject(new Error("still unreachable")),
    };
    const harness = buildHarness({}, broken);
    harness.repository.seedCustomer({ email: "abierto@akai.shop" });

    // A store outage must not become a total sign-in outage. The durable
    // account lockout (failedLoginCount/lockedUntil) still bounds brute force
    // against any one account while the counter table is down.
    expect(await loginStatus(harness, "abierto@akai.shop", PASSWORD)).toBe(200);
    // ...and the failing `reset()` on the success path must not surface either.
    expect(await loginStatus(harness, "abierto@akai.shop")).toBe(401);
  });

  it("caps outbound reset mail per address, and only for that address", async () => {
    const harness = buildHarness();
    harness.repository.seedCustomer({ email: "bombardeado@akai.shop" });
    harness.repository.seedCustomer({ email: "tranquilo@akai.shop" });

    const budget = AUTH_RATE_LIMITS.passwordResetRequest.limit;
    for (let attempt = 0; attempt < budget; attempt += 1) {
      await harness.service.requestPasswordReset("bombardeado@akai.shop");
    }

    await expect(
      harness.service.requestPasswordReset("bombardeado@akai.shop"),
    ).rejects.toSatisfy((error: unknown) => statusOf(error) === 429);

    // Exactly `budget` mails, not one more: this is the email-bomb bound.
    expect(harness.events.eventsOfType("auth.password_reset.requested")).toHaveLength(
      budget,
    );

    await expect(
      harness.service.requestPasswordReset("tranquilo@akai.shop"),
    ).resolves.toEqual({ status: "accepted" });
  });

  it("caps verification resends per address", async () => {
    const harness = buildHarness();
    harness.repository.seedCustomer({
      email: "sinverificar@akai.shop",
      emailVerifiedAt: null,
    });

    const budget = AUTH_RATE_LIMITS.resendVerification.limit;
    for (let attempt = 0; attempt < budget; attempt += 1) {
      await harness.service.resendVerification("sinverificar@akai.shop");
    }

    await expect(
      harness.service.resendVerification("sinverificar@akai.shop"),
    ).rejects.toSatisfy((error: unknown) => statusOf(error) === 429);
    expect(
      harness.events.eventsOfType("auth.email_verification.requested"),
    ).toHaveLength(budget);
  });

  it("caps registration attempts per address", async () => {
    const harness = buildHarness();
    const input = {
      email: "repetido@akai.shop",
      password: "a-sufficiently-long-password",
      firstName: "Ana",
      lastName: "Mestra",
      preferredLocale: "es" as const,
      marketingConsent: false,
    };

    const budget = AUTH_RATE_LIMITS.register.limit;
    for (let attempt = 0; attempt < budget; attempt += 1) {
      await harness.service.register(input);
    }

    // Every attempt after the first mails the real owner a "someone tried to
    // sign up" notice, so an uncapped register is an email bomb aimed at a
    // KNOWN address — which is exactly what an email-keyed budget bounds.
    await expect(harness.service.register(input)).rejects.toSatisfy(
      (error: unknown) => statusOf(error) === 429,
    );
    expect(
      harness.events.eventsOfType("auth.registration.duplicate_attempt"),
    ).toHaveLength(budget - 1);

    await expect(
      harness.service.register({ ...input, email: "distinto@akai.shop" }),
    ).resolves.toEqual({ status: "accepted" });
  });
});


// ---------------------------------------------------------------------------
// Emailed one-time sign-in codes
// ---------------------------------------------------------------------------

/**
 * The mailed code is a CREDENTIAL, not a convenience, so every test below is
 * about a property that must not regress:
 *
 *   - the stored digest is customer-bound, so a code cannot be redeemed against
 *     another account and two customers cannot collide;
 *   - an unknown address is answered identically AND costs comparable work;
 *   - guesses are bounded PER ISSUANCE and the code is burnt when they run out;
 *   - both existing 2FA gates still hold — an un-enrolled ADMIN gets no session
 *     at all, and an enrolled account still has to clear the second factor.
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Recover the issued code from the stored digest by walking the six-digit space.
 *
 * The service deliberately returns only the neutral acknowledgement and the raw
 * code exists nowhere but the mail, so this is the only way a test can hold the
 * real code. Walking 10^6 candidates is also the assertion itself: it proves the
 * digest is exactly SHA-256 over `${customerId}:${code}` and that the code is
 * drawn from the full six-digit space.
 */
function recoverLoginCode(customerId: string, codeHash: string): string {
  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const code = String(candidate).padStart(6, "0");
    if (sha256Hex(`${customerId}:${code}`) === codeHash) {
      return code;
    }
  }
  throw new Error("no six-digit code hashes to the stored digest");
}

/**
 * The code the service just mailed, read from the event that carries it to the
 * mailer — and checked against the stored digest, so a helper that returned the
 * wrong code would fail loudly rather than pass a test for the wrong reason.
 *
 * NOT `recoverLoginCode`: walking 10^6 SHA-256 candidates costs ~100-600ms per
 * call, this helper runs in dozens of tests, and under a parallel
 * `nx run-many -t test` that pushed individual tests past the 5s timeout. The
 * walk is still the assertion in the one test that is about the digest.
 */
function issuedCode(harness: Harness, customerId: string): string {
  const row = harness.repository.emailOtps.get(customerId);
  if (row === undefined) {
    throw new Error("no email_otp row was written");
  }
  const mailed = harness.events
    .eventsOfType("auth.login_code.requested")
    .filter((event) => event.customerId === customerId)
    .at(-1);
  if (mailed === undefined) {
    throw new Error("no auth.login_code.requested event was published");
  }
  if (sha256Hex(`${customerId}:${mailed.code}`) !== row.codeHash) {
    throw new Error("the mailed code does not match the stored digest");
  }
  return mailed.code;
}

/** A six-digit code that is definitely NOT the issued one. */
function wrongCode(actual: string): string {
  return actual === "000000" ? "111111" : "000000";
}

describe("email sign-in codes — issuing", () => {
  let harness: Harness;
  let customer: AuthCustomer;

  beforeEach(() => {
    harness = buildHarness();
    customer = harness.repository.seedCustomer({ email: "codigo@akai.shop" });
  });

  it("stores only a SHA-256 over `${customerId}:${code}`, never the code", async () => {
    await harness.service.issueEmailOtp(customer.email);

    const row = harness.repository.emailOtps.get(customer.id);
    expect(row?.codeHash).toHaveLength(64);

    const code = recoverLoginCode(customer.id, row?.codeHash ?? "");
    expect(code).toMatch(/^\d{6}$/);
    expect(row?.codeHash).toBe(sha256Hex(`${customer.id}:${code}`));
    // THE property `auth_token` could not provide. A digest over the bare code
    // collides across customers (10^6 values, a UNIQUE column) and can be
    // redeemed by whichever row it happens to match.
    expect(row?.codeHash).not.toBe(sha256Hex(code));
    expect(row?.codeHash).not.toContain(code);
  });

  it("keeps ONE live code per customer and resets the attempt counter", async () => {
    await harness.service.issueEmailOtp(customer.email);
    const first = harness.repository.emailOtps.get(customer.id);
    expect(first).toBeDefined();
    await harness.repository.recordEmailOtpAttempt(customer.id);
    await harness.repository.recordEmailOtpAttempt(customer.id);

    await harness.service.issueEmailOtp(customer.email);

    // The primary key is the customer id, so a re-issue REPLACES: two live
    // codes for one account cannot exist, and the new code starts with a full
    // attempt budget rather than inheriting the old one's spent guesses.
    expect(harness.repository.emailOtps.size).toBe(1);
    expect(harness.repository.emailOtps.get(customer.id)?.attempts).toBe(0);
    expect(harness.repository.emailOtps.get(customer.id)?.consumedAt).toBeNull();
  });

  it("expires the code on the policy TTL", async () => {
    await harness.service.issueEmailOtp(customer.email);
    const row = harness.repository.emailOtps.get(customer.id);
    expect(row?.expiresAt.getTime()).toBe(
      START.getTime() + DEFAULT_AUTH_POLICY.loginCodeTtlMs,
    );
  });

  it("pins the LITERAL values that are the security argument", () => {
    // THESE ASSERTIONS EXIST BECAUSE THE ONES ABOVE CANNOT FAIL. Comparing a
    // computed expiry against `DEFAULT_AUTH_POLICY.loginCodeTtlMs`, or looping
    // `AUTH_RATE_LIMITS.loginCodeRequest.limit` times, compares the policy with
    // itself: the TTL could be raised to thirty days and the budget to 5000 and
    // every one of those tests would stay green.
    //
    // The numbers ARE the argument. A six-digit code has 10^6 values, so its
    // window is its strength — ten minutes against a 10-per-15-minute verify
    // budget is the trade. And the request budget is the mail-bomb bound on an
    // endpoint an unauthenticated caller can aim at any address. A constant
    // whose value is the security case needs a test that fails when it changes.
    expect(DEFAULT_AUTH_POLICY.loginCodeTtlMs).toBe(10 * 60 * 1000);
    expect(DEFAULT_AUTH_POLICY.loginCodeMaxAttempts).toBe(5);
    expect(AUTH_RATE_LIMITS.loginCodeRequest).toEqual({
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    expect(AUTH_RATE_LIMITS.loginCodeVerify).toEqual({
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
  });

  it("answers an unknown address with the IDENTICAL acknowledgement", async () => {
    const known = await harness.service.issueEmailOtp(customer.email);
    const unknown = await harness.service.issueEmailOtp("nadie@akai.shop");

    expect(unknown).toEqual(known);
    expect(harness.repository.emailOtps.size).toBe(1);
  });

  it("burns comparable work for an unknown address so latency does not enumerate", async () => {
    harness.repository.emailOtpReads.length = 0;
    await harness.service.issueEmailOtp("nadie@akai.shop");

    // A short-circuit `return ACKNOWLEDGEMENT` would leave this at 0, making an
    // unknown address measurably faster than a real one — a brand-new oracle on
    // top of the identical response body.
    expect(harness.repository.emailOtpReads).toHaveLength(1);
    expect(harness.repository.emailOtpReads[0]).not.toBe(customer.id);
  });

  it("spends the per-email budget for an unknown address exactly as for a known one", async () => {
    const budget = AUTH_RATE_LIMITS.loginCodeRequest.limit;

    for (let attempt = 0; attempt < budget; attempt += 1) {
      await harness.service.issueEmailOtp("existe@akai.shop");
      await harness.service.issueEmailOtp("nadie@akai.shop");
    }

    // A budget that only counted for real accounts would answer 429 for one and
    // 202 for the other, which is a working account-existence oracle.
    await expect(harness.service.issueEmailOtp("existe@akai.shop")).rejects.toSatisfy(
      (error: unknown) => statusOf(error) === 429,
    );
    await expect(harness.service.issueEmailOtp("nadie@akai.shop")).rejects.toSatisfy(
      (error: unknown) => statusOf(error) === 429,
    );
    // ...and a third address is untouched: the bucket is per-address, never one
    // shared bucket for the whole user base.
    await expect(
      harness.service.issueEmailOtp("otra@akai.shop"),
    ).resolves.toEqual({ status: "accepted" });
  });

  it("issues nothing to an anonymised account", async () => {
    const erased = harness.repository.seedCustomer({
      email: "borrado@akai.shop",
      anonymisedAt: new Date(START),
    });

    await expect(harness.service.issueEmailOtp(erased.email)).resolves.toEqual({
      status: "accepted",
    });
    expect(harness.repository.emailOtps.has(erased.id)).toBe(false);
  });
});

describe("email sign-in codes — verifying", () => {
  let harness: Harness;
  let customer: AuthCustomer;

  beforeEach(() => {
    harness = buildHarness();
    customer = harness.repository.seedCustomer({
      email: "codigo@akai.shop",
      emailVerifiedAt: null,
    });
  });

  async function issue(): Promise<string> {
    await harness.service.issueEmailOtp(customer.email);
    return issuedCode(harness, customer.id);
  }

  it("mints a session through the existing token machinery", async () => {
    const code = await issue();

    const result = await harness.service.consumeEmailOtp(
      { email: customer.email, loginCode: code },
      CONTEXT,
    );

    if (result.requiresTwoFactor) {
      throw new Error("expected a completed sign-in");
    }
    expect(result.customer.id).toBe(customer.id);
    expect(result.tokens.refreshToken).toBeTruthy();
    expect(harness.repository.sessions.size).toBe(1);

    // The refresh token is stored hashed, in a family, exactly as a password
    // login stores it — reuse detection must still hold for a code sign-in.
    const [stored] = [...harness.repository.refreshTokens.values()];
    expect(stored?.tokenHash).toHaveLength(64);
    expect(stored?.tokenHash).not.toBe(result.tokens.refreshToken);
    expect(stored?.familyId).toBeTruthy();
  });

  it("marks the address verified — receiving the code proves mailbox control", async () => {
    const code = await issue();
    await harness.service.consumeEmailOtp(
      { email: customer.email, loginCode: code },
      CONTEXT,
    );

    // Without this a code-only customer stays "unverified" for ever, exactly as
    // confirmPasswordReset avoids for the reset link.
    const stored = await harness.repository.findCustomerById(customer.id);
    expect(stored?.emailVerifiedAt).not.toBeNull();
  });

  it("is single-use", async () => {
    const code = await issue();
    await harness.service.consumeEmailOtp(
      { email: customer.email, loginCode: code },
      CONTEXT,
    );

    await expect(
      harness.service.consumeEmailOtp({ email: customer.email, loginCode: code }, CONTEXT),
    ).rejects.toThrow();
    expect(harness.repository.sessions.size).toBe(1);
  });

  it("refuses a code past its TTL", async () => {
    const code = await issue();
    harness.advance(DEFAULT_AUTH_POLICY.loginCodeTtlMs + 1);

    await expect(
      harness.service.consumeEmailOtp({ email: customer.email, loginCode: code }, CONTEXT),
    ).rejects.toThrow();
    expect(harness.repository.sessions.size).toBe(0);
  });

  it("rejects a wrong code and an unknown address IDENTICALLY", async () => {
    const code = await issue();

    const badCode = await harness.service
      .consumeEmailOtp({ email: customer.email, loginCode: wrongCode(code) }, CONTEXT)
      .catch((error: unknown) => error);
    const unknownAccount = await harness.service
      .consumeEmailOtp({ email: "nadie@akai.shop", loginCode: code }, CONTEXT)
      .catch((error: unknown) => error);

    expect((badCode as Error).message).toBe((unknownAccount as Error).message);
    expect((badCode as Error).constructor).toBe((unknownAccount as Error).constructor);
  });

  it("burns comparable work for an unknown address", async () => {
    harness.repository.emailOtpReads.length = 0;
    await harness.service
      .consumeEmailOtp({ email: "nadie@akai.shop", loginCode: "123456" }, CONTEXT)
      .catch(() => undefined);

    expect(harness.repository.emailOtpReads).toHaveLength(1);
    expect(harness.repository.emailOtpReads[0]).not.toBe(customer.id);
  });

  it("BURNS the code once the per-issuance attempt cap is exhausted", async () => {
    const code = await issue();
    const cap = DEFAULT_AUTH_POLICY.loginCodeMaxAttempts;

    for (let attempt = 0; attempt < cap; attempt += 1) {
      await expect(
        harness.service.consumeEmailOtp(
          { email: customer.email, loginCode: wrongCode(code) },
          CONTEXT,
        ),
      ).rejects.toThrow();
    }

    // Burnt, not merely counted: guesses are bounded PER ISSUANCE, so an
    // attacker cannot walk one live code from a fresh source address. The
    // CORRECT code is dead too — that is the point.
    expect(harness.repository.emailOtps.has(customer.id)).toBe(false);
    await expect(
      harness.service.consumeEmailOtp({ email: customer.email, loginCode: code }, CONTEXT),
    ).rejects.toThrow();
    expect(harness.repository.sessions.size).toBe(0);
  });

  it("rate-limits verification per address, leaving another address untouched", async () => {
    const budget = AUTH_RATE_LIMITS.loginCodeVerify.limit;

    for (let attempt = 0; attempt < budget; attempt += 1) {
      await harness.service
        .consumeEmailOtp({ email: "victima@akai.shop", loginCode: "000000" }, CONTEXT)
        .catch(() => undefined);
    }

    await expect(
      harness.service.consumeEmailOtp(
        { email: "victima@akai.shop", loginCode: "000000" },
        CONTEXT,
      ),
    ).rejects.toSatisfy((error: unknown) => statusOf(error) === 429);

    // If this is 429 the whole user base shares one bucket and nobody can sign
    // in the moment one address is throttled.
    await expect(
      harness.service.consumeEmailOtp(
        { email: "otra@akai.shop", loginCode: "000000" },
        CONTEXT,
      ),
    ).rejects.toSatisfy((error: unknown) => statusOf(error) === 401);
  });

  it("lifts the durable lockout on a successful code sign-in", async () => {
    harness.repository.seedCustomer({
      email: "bloqueado@akai.shop",
      failedLoginCount: 9,
      lockedUntil: new Date(START.getTime() + 60_000),
    });
    const locked = await harness.repository.findCustomerByEmail("bloqueado@akai.shop");
    await harness.service.issueEmailOtp("bloqueado@akai.shop");
    const code = issuedCode(harness, locked?.id ?? "");

    const result = await harness.service.consumeEmailOtp(
      { email: "bloqueado@akai.shop", loginCode: code },
      CONTEXT,
    );

    // Same call the reset link makes: the mailbox owner just proved themselves,
    // and leaving the lockout armed would let an attacker deny them BOTH
    // routes back into the account with ten bad passwords.
    expect(result.requiresTwoFactor).toBe(false);
    const stored = await harness.repository.findCustomerById(locked?.id ?? "");
    expect(stored?.failedLoginCount).toBe(0);
    expect(stored?.lockedUntil).toBeNull();
  });

  it("refuses an anonymised account", async () => {
    const erased = harness.repository.seedCustomer({
      email: "borrado@akai.shop",
      anonymisedAt: new Date(START),
    });
    await harness.repository.upsertEmailOtp({
      customerId: erased.id,
      codeHash: sha256Hex(`${erased.id}:123456`),
      expiresAt: new Date(START.getTime() + 600_000),
    });

    await expect(
      harness.service.consumeEmailOtp(
        { email: erased.email, loginCode: "123456" },
        CONTEXT,
      ),
    ).rejects.toThrow();
  });
});

describe("email sign-in codes — the two-factor gates still hold", () => {
  let harness: Harness;
  const SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  beforeEach(() => {
    harness = buildHarness();
  });

  it("NEVER ISSUES A CODE to a privileged account, and tells nobody it did not", async () => {
    const admin = harness.repository.seedCustomer({
      email: "admin@akai.shop",
      role: "ADMIN",
      totpEnabledAt: null,
    });

    // STRONGER THAN THE GATE THIS REPLACES. That one let an ADMIN be issued a
    // code and refused it at redemption. But a mailed code plus a role that
    // never enrolled TOTP is a passwordless route into a privileged account —
    // and unlike a password reset, which is loud and locks the victim out
    // visibly, reading a code leaves the real owner no signal at all. So no
    // code exists in the first place, for any role but CUSTOMER, which also
    // means a role added later is excluded by default.
    const unknown = await harness.service.issueEmailOtp("nadie@akai.shop");
    const forAdmin = await harness.service.issueEmailOtp(admin.email);

    expect(harness.repository.emailOtps.has(admin.id)).toBe(false);
    // Byte-identical to the answer an address with no account gets, so this is
    // not an oracle for "which of these addresses belongs to staff".
    expect(forAdmin).toEqual(unknown);
    expect(harness.repository.sessions.size).toBe(0);
    expect(harness.repository.refreshTokens.size).toBe(0);
  });

  it("still demands the second factor from an enrolled account", async () => {
    const customer = harness.repository.seedCustomer({
      email: "doble@akai.shop",
      totpSecret: seal(SECRET, deriveEncryptionKey(ROOT_SECRET)),
      totpEnabledAt: new Date(START),
    });
    await harness.service.issueEmailOtp(customer.email);
    const code = issuedCode(harness, customer.id);

    const challenge = await harness.service.consumeEmailOtp(
      { email: customer.email, loginCode: code },
      CONTEXT,
    );

    expect(challenge.requiresTwoFactor).toBe(true);
    expect(harness.repository.sessions.size).toBe(0);
    expect(harness.repository.refreshTokens.size).toBe(0);
    // The challenge must NOT spend the code, or the second leg — which has to
    // resend it alongside the TOTP — would always be rejected.
    expect(harness.repository.emailOtps.get(customer.id)?.consumedAt).toBeNull();
  });

  it("completes with a valid TOTP and marks the session asserted", async () => {
    const customer = harness.repository.seedCustomer({
      email: "doble@akai.shop",
      totpSecret: seal(SECRET, deriveEncryptionKey(ROOT_SECRET)),
      totpEnabledAt: new Date(START),
    });
    await harness.service.issueEmailOtp(customer.email);
    const code = issuedCode(harness, customer.id);
    const totpCode = harness.totp.generate(SECRET, new Date(START)) ?? "";

    const result = await harness.service.consumeEmailOtp(
      { email: customer.email, loginCode: code, totpCode },
      CONTEXT,
    );

    expect(result.requiresTwoFactor).toBe(false);
    const [session] = [...harness.repository.sessions.values()];
    expect(session?.twoFactorAssertedAt).not.toBeNull();
    expect(harness.repository.emailOtps.get(customer.id)?.consumedAt).not.toBeNull();
  });

  it("spends the CODE's budget on a wrong TOTP, and refuses to arm the durable lockout", async () => {
    const customer = harness.repository.seedCustomer({
      email: "doble@akai.shop",
      totpSecret: seal(SECRET, deriveEncryptionKey(ROOT_SECRET)),
      totpEnabledAt: new Date(START),
    });
    await harness.service.issueEmailOtp(customer.email);
    const code = issuedCode(harness, customer.id);

    await expect(
      harness.service.consumeEmailOtp(
        { email: customer.email, loginCode: code, totpCode: "000000" },
        CONTEXT,
      ),
    ).rejects.toThrow();

    // THE PER-ISSUANCE CAP BINDS ON THIS LEG TOO. Without it the mailed code
    // bounded nothing here: whoever held a valid code could guess TOTPs for its
    // entire life at the verify budget's rate, and the code would never die.
    expect(harness.repository.emailOtps.get(customer.id)?.attempts).toBe(1);

    // AND THE DURABLE LOCKOUT IS NOT ARMED FROM HERE — this assertion replaces
    // one demanding the opposite. This route ignores `lockedUntil` on purpose,
    // so that it stays the way back in after ten bad passwords from a stranger.
    // A route that arms a lockout it exempts itself from is a tool for holding
    // the real owner out of PASSWORD sign-in while remaining open to whoever
    // holds the code. Guesses here are bounded by the cap above and the verify
    // budget instead.
    const stored = await harness.repository.findCustomerById(customer.id);
    expect(stored?.failedLoginCount).toBe(0);
    expect(stored?.lockedUntil).toBeNull();
    expect(harness.repository.sessions.size).toBe(0);
  });
});
