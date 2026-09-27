import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { AdminSessionReader, AdminSessionSnapshot } from "./admin.types";

/**
 * Default AdminSessionReader — reads the live session + role from Postgres.
 *
 * This is the concrete half of the spec §8 rule "the role is re-read from the DB
 * session row on every request". It joins to the customer because the role lives
 * there, not on the session: a role cached onto the session row would go stale
 * the moment an admin is demoted, which is exactly the failure the rule exists
 * to prevent.
 *
 * Rebind ADMIN_SESSION_READER to AuthModule's implementation at integration —
 * this class is a correct default, not a claim of ownership over sessions.
 */
@Injectable()
export class PrismaAdminSessionReader implements AdminSessionReader {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveSession(sessionId: string): Promise<AdminSessionSnapshot | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        customerId: true,
        revokedAt: true,
        expiresAt: true,
        twoFactorAssertedAt: true,
        customer: { select: { role: true, anonymisedAt: true, lockedUntil: true } },
      },
    });

    if (session === null) {
      return null;
    }

    // An anonymised (GDPR-erased) or locked-out customer keeps their session
    // rows, so the session alone is not proof of a usable account. Returning
    // null here funnels both cases into the guard's 401 branch rather than
    // letting a tombstoned identity authorise an admin mutation.
    if (session.customer.anonymisedAt !== null) {
      return null;
    }
    const lockedUntil = session.customer.lockedUntil;
    if (lockedUntil !== null && lockedUntil.getTime() > Date.now()) {
      return null;
    }

    return {
      sessionId: session.id,
      customerId: session.customerId,
      role: session.customer.role,
      revokedAt: session.revokedAt,
      expiresAt: session.expiresAt,
      twoFactorAssertedAt: session.twoFactorAssertedAt,
    };
  }
}
