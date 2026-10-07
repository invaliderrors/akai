import { Injectable } from "@nestjs/common";
import { Prisma } from "@akai/db";
import type {
  Customer as PrismaCustomer,
  RefreshToken as PrismaRefreshToken,
  Session as PrismaSession,
} from "@akai/db";

/**
 * `libs/db` re-exports most model types but not `AuthToken` (nor
 * `RecoveryCode`), so it is derived from the `Prisma` namespace that lib DOES
 * export. Deriving rather than hand-writing an interface keeps this tied to the
 * schema: a column added or renamed in schema.prisma shows up here as a compile
 * error instead of a silent mismatch. Adding the missing re-export to libs/db is
 * a followUp — that lib belongs to another agent this pass.
 */
type PrismaAuthToken = Prisma.AuthTokenGetPayload<Record<string, never>>;
/** Same story as `AuthToken`: `libs/db` does not re-export `EmailOtp` yet. */
type PrismaEmailOtp = Prisma.EmailOtpGetPayload<Record<string, never>>;
import { PrismaService } from "../prisma/prisma.service";
import type { AuthRepository } from "./auth.repository";
import { DuplicateEmailError } from "./auth.errors";
import {
  AUTH_TOKEN_PURPOSES,
  type AuthCustomer,
  type AuthTokenPurpose,
  type AuthTokenRecord,
  type EmailOtpRecord,
  type RefreshTokenRecord,
  type SessionRecord,
} from "./auth.types";

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

/** Prisma's "an update matched no row". */
const RECORD_NOT_FOUND = "P2025";

/**
 * `AuthToken.purpose` is a VarChar, not a Prisma enum, so a value read back
 * from the database is only `string` as far as the type system is concerned.
 * Narrowing it here — rather than casting — means a row written by a future
 * migration with an unrecognised purpose is treated as an invalid token
 * instead of flowing into a comparison that silently never matches.
 */
function narrowPurpose(value: string): AuthTokenPurpose | null {
  return AUTH_TOKEN_PURPOSES.find((purpose) => purpose === value) ?? null;
}

function toAuthCustomer(row: PrismaCustomer): AuthCustomer {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    role: row.role,
    totpSecret: row.totpSecret,
    totpEnabledAt: row.totpEnabledAt,
    anonymisedAt: row.anonymisedAt,
    failedLoginCount: row.failedLoginCount,
    lockedUntil: row.lockedUntil,
    marketingConsentAt: row.marketingConsentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEmailOtpRecord(row: PrismaEmailOtp): EmailOtpRecord {
  return {
    customerId: row.customerId,
    codeHash: row.codeHash,
    attempts: row.attempts,
    consumedAt: row.consumedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function toSessionRecord(row: PrismaSession): SessionRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    twoFactorAssertedAt: row.twoFactorAssertedAt,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

function toRefreshTokenRecord(row: PrismaRefreshToken): RefreshTokenRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    sessionId: row.sessionId,
    familyId: row.familyId,
    tokenHash: row.tokenHash,
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function toAuthTokenRecord(row: PrismaAuthToken): AuthTokenRecord | null {
  const purpose = narrowPurpose(row.purpose);
  if (purpose === null) {
    return null;
  }
  return {
    id: row.id,
    customerId: row.customerId,
    purpose,
    tokenHash: row.tokenHash,
    usedAt: row.usedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * The Prisma-backed AuthRepository.
 *
 * Deliberately thin: it contains no policy, no branching on security rules and
 * no derived state — every decision lives in AuthService, which is unit-tested
 * against an in-memory implementation of this same interface.
 *
 * The one thing this file DOES own is the concurrency guarantee. The three
 * `consume*` methods are single conditional UPDATEs whose affected-row count is
 * the answer, never a read followed by a write. That is what makes "single use"
 * true under two simultaneous requests, and it is the property most easily lost
 * by a well-meaning refactor into find-then-update.
 */
@Injectable()
export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- customers -----------------------------------------------------------

  async findCustomerByEmail(email: string): Promise<AuthCustomer | null> {
    // `email` is a citext column, so this is case-insensitive at the database
    // level; the schema also lower-cases it at the zod boundary.
    const row = await this.prisma.customer.findUnique({ where: { email } });
    return row === null ? null : toAuthCustomer(row);
  }

  async findCustomerById(id: string): Promise<AuthCustomer | null> {
    const row = await this.prisma.customer.findUnique({ where: { id } });
    return row === null ? null : toAuthCustomer(row);
  }

  async createCustomer(input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly marketingConsentAt: Date | null;
  }): Promise<AuthCustomer> {
    try {
      const row = await this.prisma.customer.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          marketingConsentAt: input.marketingConsentAt,
          // NEVER accepted from the request. Role escalation at signup would be
          // the single worst bug this module could ship, so the value is
          // written here as a constant rather than passed in.
          role: "CUSTOMER",
        },
      });
      return toAuthCustomer(row);
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        // Translated into a domain error so AuthService never has to know what
        // "P2002" means — and so the neutral, non-enumerating response is
        // chosen by domain logic rather than by a driver-specific check.
        throw new DuplicateEmailError();
      }
      throw error;
    }
  }

  async updatePasswordHash(customerId: string, passwordHash: string): Promise<void> {
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { passwordHash },
    });
  }

  async recordFailedLogin(customerId: string, lockedUntil: Date | null): Promise<void> {
    await this.prisma.customer.update({
      where: { id: customerId },
      // `increment` rather than a read-modify-write: concurrent failed attempts
      // must each count, and a lost update here would raise the effective
      // lockout threshold under exactly the parallel-guessing conditions the
      // lockout exists to stop.
      data: { failedLoginCount: { increment: 1 }, lockedUntil },
    });
  }

  async clearFailedLogins(customerId: string): Promise<void> {
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  async markEmailVerified(customerId: string, verifiedAt: Date): Promise<void> {
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { emailVerifiedAt: verifiedAt },
    });
  }

  async setTotpSecret(
    customerId: string,
    sealedSecret: string | null,
    enabledAt: Date | null,
  ): Promise<void> {
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { totpSecret: sealedSecret, totpEnabledAt: enabledAt },
    });
  }

  // --- sessions ------------------------------------------------------------

  async createSession(input: {
    readonly customerId: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly expiresAt: Date;
    readonly twoFactorAssertedAt: Date | null;
  }): Promise<SessionRecord> {
    const row = await this.prisma.session.create({
      data: {
        customerId: input.customerId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        expiresAt: input.expiresAt,
        twoFactorAssertedAt: input.twoFactorAssertedAt,
      },
    });
    return toSessionRecord(row);
  }

  async findSessionById(id: string): Promise<SessionRecord | null> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    return row === null ? null : toSessionRecord(row);
  }

  async listActiveSessions(
    customerId: string,
    now: Date,
  ): Promise<readonly SessionRecord[]> {
    const rows = await this.prisma.session.findMany({
      where: { customerId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
    });
    return rows.map(toSessionRecord);
  }

  async touchSession(id: string, lastSeenAt: Date): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { lastSeenAt } });
  }

  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    // updateMany, not update: revoking an already-revoked or absent session is
    // a no-op rather than a thrown P2025. Logout must be idempotent — a user
    // double-clicking "sign out" is not an error condition.
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeAllSessions(
    customerId: string,
    revokedAt: Date,
    exceptSessionId: string | null,
  ): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        customerId,
        revokedAt: null,
        ...(exceptSessionId === null ? {} : { id: { not: exceptSessionId } }),
      },
      data: { revokedAt },
    });
  }

  async markTwoFactorAsserted(sessionId: string, assertedAt: Date): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { twoFactorAssertedAt: assertedAt },
    });
  }

  // --- refresh tokens ------------------------------------------------------

  async createRefreshToken(input: {
    readonly customerId: string;
    readonly sessionId: string;
    readonly familyId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const row = await this.prisma.refreshToken.create({ data: { ...input } });
    return toRefreshTokenRecord(row);
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    return row === null ? null : toRefreshTokenRecord(row);
  }

  async consumeRefreshToken(id: string, consumedAt: Date): Promise<boolean> {
    // THE conditional write. `consumedAt: null` in the WHERE clause is what
    // makes this atomic: two concurrent redemptions of the same token produce
    // one count-1 and one count-0, and the loser is treated as a replay.
    const result = await this.prisma.refreshToken.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt },
    });
    return result.count === 1;
  }

  async revokeRefreshTokenFamily(familyId: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeAllRefreshTokens(customerId: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { customerId, revokedAt: null },
      data: { revokedAt },
    });
  }

  // --- email verification / password reset ---------------------------------

  async createAuthToken(input: {
    readonly customerId: string;
    readonly purpose: AuthTokenPurpose;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AuthTokenRecord> {
    const row = await this.prisma.authToken.create({ data: { ...input } });
    const record = toAuthTokenRecord(row);
    if (record === null) {
      // Unreachable: we just wrote a value from the AuthTokenPurpose union.
      throw new Error(`Unrecognised auth token purpose: ${row.purpose}`);
    }
    return record;
  }

  async findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRecord | null> {
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash } });
    return row === null ? null : toAuthTokenRecord(row);
  }

  async consumeAuthToken(id: string, usedAt: Date): Promise<boolean> {
    const result = await this.prisma.authToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt },
    });
    return result.count === 1;
  }

  async invalidateAuthTokens(
    customerId: string,
    purpose: AuthTokenPurpose,
    usedAt: Date,
  ): Promise<void> {
    await this.prisma.authToken.updateMany({
      where: { customerId, purpose, usedAt: null },
      data: { usedAt },
    });
  }

  // --- recovery codes ------------------------------------------------------

  async replaceRecoveryCodes(
    customerId: string,
    codeHashes: readonly string[],
  ): Promise<void> {
    // One transaction: a partial replace would leave the account with a mix of
    // old and new codes, and the user holding a printout of only the new ones.
    await this.prisma.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { customerId } });
      if (codeHashes.length > 0) {
        await tx.recoveryCode.createMany({
          data: codeHashes.map((codeHash) => ({ customerId, codeHash })),
        });
      }
    });
  }

  async consumeRecoveryCode(
    customerId: string,
    codeHash: string,
    usedAt: Date,
  ): Promise<boolean> {
    // Scoped by customerId as well as the hash. Matching on the hash alone
    // would let one customer's code satisfy another customer's challenge if the
    // values ever collided — vanishingly unlikely, but free to rule out.
    const result = await this.prisma.recoveryCode.updateMany({
      where: { customerId, codeHash, usedAt: null },
      data: { usedAt },
    });
    return result.count === 1;
  }

  async countUnusedRecoveryCodes(customerId: string): Promise<number> {
    return this.prisma.recoveryCode.count({ where: { customerId, usedAt: null } });
  }

  // --- emailed one-time sign-in codes --------------------------------------

  async upsertEmailOtp(input: {
    readonly customerId: string;
    readonly codeHash: string;
    readonly expiresAt: Date;
  }): Promise<EmailOtpRecord> {
    // UPSERT on the primary key. The update branch resets `attempts` and
    // `consumedAt`: a re-issued code must start with a full guess budget, and a
    // row left holding the previous code's spent attempts would burn the new
    // code on its first wrong guess.
    const row = await this.prisma.emailOtp.upsert({
      where: { customerId: input.customerId },
      create: {
        customerId: input.customerId,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
      },
      update: {
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
      },
    });
    return toEmailOtpRecord(row);
  }

  async findEmailOtp(customerId: string): Promise<EmailOtpRecord | null> {
    const row = await this.prisma.emailOtp.findUnique({ where: { customerId } });
    return row === null ? null : toEmailOtpRecord(row);
  }

  async consumeEmailOtp(
    customerId: string,
    codeHash: string,
    consumedAt: Date,
  ): Promise<boolean> {
    // THE conditional write. Expiry is in the WHERE clause too, so a code that
    // lapses between the read and this statement cannot be redeemed by the
    // request that read it a millisecond earlier.
    const result = await this.prisma.emailOtp.updateMany({
      where: {
        customerId,
        codeHash,
        consumedAt: null,
        expiresAt: { gt: consumedAt },
      },
      data: { consumedAt },
    });
    return result.count === 1;
  }

  async recordEmailOtpAttempt(customerId: string): Promise<number | null> {
    try {
      const row = await this.prisma.emailOtp.update({
        where: { customerId },
        // `increment`, never read-modify-write: two parallel guesses must both
        // count against the cap.
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      return row.attempts;
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === RECORD_NOT_FOUND
      ) {
        // A concurrent request already burnt the code. Null says "no live code",
        // which the service treats exactly as an exhausted one.
        return null;
      }
      throw error;
    }
  }

  async deleteEmailOtp(customerId: string): Promise<void> {
    // deleteMany, not delete: burning an already-burnt code is a no-op rather
    // than a thrown P2025.
    await this.prisma.emailOtp.deleteMany({ where: { customerId } });
  }
}
