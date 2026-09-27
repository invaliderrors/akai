import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Role } from "@akai/contracts";
import { getRequestId } from "@akai/observability";
import { ADMIN_FRESH_2FA_KEY, ADMIN_ROLES_KEY } from "./admin.decorators";
import { PRINCIPAL_REQUEST_KEY } from "../auth/security/principal";
import {
  ADMIN_SESSION_READER,
  narrowPrincipal,
  type AdminActor,
  type AdminSessionReader,
  type AdminSessionSnapshot,
} from "./admin.types";

/**
 * How recent a 2FA assertion must be to authorise a step-up operation.
 *
 * Fifteen minutes: long enough that an admin doing a batch of edits is not
 * re-prompted constantly, short enough that a session lifted from a walked-away
 * laptop is not indefinitely privileged.
 */
export const TWO_FACTOR_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * The request as this module sees it.
 *
 * `user` is `unknown` on purpose: it is populated by an auth layer this module
 * does not own, so it is narrowed (never trusted) before use. `adminActor` is
 * what THIS guard puts back once identity is proven.
 */
export interface AdminHttpRequest extends Request {
  adminActor?: AdminActor;
}

/**
 * Read the principal off the request as `unknown`.
 *
 * `Reflect.get` is typed `any`, so its result is funnelled through an explicit
 * `unknown` return rather than flowing into the narrowing function as `any` —
 * which would make `narrowPrincipal`'s parse look like a check while actually
 * accepting anything the compiler was told not to look at.
 */
function readAttachedPrincipal(request: object): unknown {
  if (!(PRINCIPAL_REQUEST_KEY in request)) {
    return null;
  }
  const value: unknown = Reflect.get(request, PRINCIPAL_REQUEST_KEY);
  return value;
}

/**
 * AdminGuard — the authorisation boundary for every /admin/* route.
 *
 * DESIGN NOTE (deliberate, please read before "simplifying"):
 * this guard does NOT assume the global RolesGuard has already run. Spec §8's
 * global JwtAuthGuard + RolesGuard are now registered in AppModule, so these
 * checks ARE redundant — deliberately. Redundant authorisation on the
 * privileged surface is the correct thing to be left with, and this guard
 * verifies strictly more than the global one: it re-reads the session row,
 * checks revocation and expiry, and rejects a token spliced onto a session it
 * does not own. Removing it would trade a real defence for a shorter file.
 *
 * The token is used for exactly one thing: naming which session to look up.
 * Every authorisation FACT comes from the DB row.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ADMIN_SESSION_READER)
    private readonly sessions: AdminSessionReader,
  ) {}

  /**
   * Current time, as a method rather than an injected clock.
   *
   * An injected `() => Date` would be a constructor parameter whose emitted
   * design:paramtype is `Function`, which Nest would try to resolve as a
   * provider and fail on at runtime — a DI error, not a compile error. Tests
   * control time with fake timers instead.
   */
  protected now(): Date {
    return new Date();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminHttpRequest>();

    // Read from where JwtAuthGuard actually parks the principal, not from
    // `request.user` — nothing populates that field.
    const principal = narrowPrincipal(readAttachedPrincipal(request));
    if (principal === null) {
      // 401, not 403: nothing has been authenticated yet, so there is no
      // identity to deny. Conflating the two makes an expired session look like
      // a permissions problem to the dashboard and it stops offering re-login.
      throw new UnauthorizedException("Authentication required");
    }

    const session = await this.sessions.findActiveSession(principal.sessionId);
    if (session === null) {
      throw new UnauthorizedException("Session not found");
    }

    this.assertSessionUsable(session);

    // Session fixation / token-splicing defence: the token names a session, but
    // the session names its own owner. If they disagree, an access token has
    // been paired with a session it does not belong to and the request is
    // rejected outright rather than resolved in favour of either party.
    if (session.customerId !== principal.sub) {
      throw new UnauthorizedException("Session does not belong to this principal");
    }

    const allowed = this.requiredRoles(context);
    if (!allowed.includes(session.role)) {
      throw new ForbiddenException("Insufficient role for the admin surface");
    }

    if (this.requiresFreshTwoFactor(context)) {
      this.assertFreshTwoFactor(session);
    }

    const actor: AdminActor = {
      customerId: session.customerId,
      sessionId: session.sessionId,
      // The DB role, never the token role. This is the line that makes a
      // demotion take effect immediately instead of at token expiry.
      role: session.role,
      ipAddress: this.readIp(request),
      userAgent: this.readHeader(request, "user-agent"),
      requestId: getRequestId(),
    };

    request.adminActor = actor;
    return true;
  }

  private assertSessionUsable(session: AdminSessionSnapshot): void {
    if (session.revokedAt !== null) {
      throw new UnauthorizedException("Session revoked");
    }
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      throw new UnauthorizedException("Session expired");
    }
  }

  private assertFreshTwoFactor(session: AdminSessionSnapshot): void {
    const assertedAt = session.twoFactorAssertedAt;
    if (assertedAt === null) {
      throw new ForbiddenException("Two-factor assertion required");
    }
    const age = this.now().getTime() - assertedAt.getTime();
    // A future-dated assertion is a clock problem or a forged row; either way it
    // is not evidence of a recent challenge, so it is rejected rather than
    // treated as maximally fresh.
    if (age < 0 || age > TWO_FACTOR_FRESHNESS_MS) {
      throw new ForbiddenException("Two-factor assertion is stale");
    }
  }

  /**
   * Roles permitted on this handler, defaulting to ADMIN when unannotated.
   * Fail-closed: see the note on `AdminRoles`.
   */
  private requiredRoles(context: ExecutionContext): readonly Role[] {
    const roles = this.reflector.getAllAndOverride<readonly Role[] | undefined>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    return roles === undefined || roles.length === 0 ? ["ADMIN"] : roles;
  }

  private requiresFreshTwoFactor(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_FRESH_2FA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private readIp(request: AdminHttpRequest): string | null {
    // `req.ip` is a prototype GETTER on Express, not an own property — anything
    // that copies the request (a spread, a shallow clone) silently loses it and
    // every audit row lands with a null IP.
    const ip = request.ip;
    return typeof ip === "string" && ip.length > 0 ? ip : null;
  }

  private readHeader(request: AdminHttpRequest, header: "user-agent"): string | null {
    const value = request.headers[header];
    if (typeof value === "string") {
      // Bounded to the audit column width (512) at the point of capture, not at
      // write time — an oversized header must never be able to fail an INSERT
      // that an audit row depends on.
      return value.slice(0, 512);
    }
    return null;
  }
}
