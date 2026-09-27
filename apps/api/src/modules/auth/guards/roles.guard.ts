import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@akai/contracts";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { AUTH_POLICY, type AuthPolicy } from "../auth.policy";
import { insufficientRole, notAuthenticated, twoFactorRequired } from "../auth.errors";
import { CLOCK, type Clock } from "../ports/clock.port";
import { readPrincipal, type Principal } from "../security/principal";

export const ROLES_KEY = "akai:roles";

/**
 * `@Roles("ADMIN")` — restrict a route to a set of roles.
 *
 * Absence of this decorator means "any authenticated principal", NOT "anyone":
 * the API is deny-by-default and `@Public()` is the only way out. So forgetting
 * `@Roles` on a new admin endpoint yields an endpoint every logged-in customer
 * can reach — which is why admin controllers carry the decorator at CLASS
 * level, where it cannot be forgotten on a newly added method.
 */
export const Roles = (...roles: readonly Role[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);

/** Roles that constitute privileged access to other people's data. */
export const ELEVATED_ROLES: readonly Role[] = ["STAFF", "ADMIN"];

/**
 * Role and step-up authorisation. Canonical home (spec §8).
 *
 * Supersedes the provisional copy in modules/users/security/roles.guard.ts,
 * whose semantics this reproduces exactly — with two changes that only make the
 * behaviour testable rather than altering it: the freshness window comes from
 * the injected AuthPolicy instead of a module constant, and time comes from the
 * injected Clock instead of `Date.now()`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_POLICY) private readonly policy: AuthPolicy,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") {
      return true;
    }

    const targets = [context.getHandler(), context.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      targets,
    );
    if (isPublic === true) {
      return true;
    }

    // Authentication is checked first, always. Answering "you lack the ADMIN
    // role" to an anonymous caller would confirm the route exists and hint at
    // what it guards.
    const principal = readPrincipal(context.switchToHttp().getRequest<unknown>());
    if (principal === null) {
      throw notAuthenticated();
    }

    const required = this.reflector.getAllAndOverride<readonly Role[] | undefined>(
      ROLES_KEY,
      targets,
    );

    // No @Roles: authenticated is sufficient. Handlers still scope every query
    // to principal.customerId, so this is a customer-OWNED route, not an open one.
    if (required === undefined || required.length === 0) {
      return true;
    }

    if (!required.includes(principal.role)) {
      throw insufficientRole();
    }

    // Step-up is applied when the ROUTE is elevated, not when the principal
    // happens to be an admin — an admin reading their own profile through a
    // customer route should not be forced through a TOTP prompt.
    if (required.some((role) => ELEVATED_ROLES.includes(role))) {
      this.assertFreshTwoFactor(principal);
    }

    return true;
  }

  private assertFreshTwoFactor(principal: Principal): void {
    if (principal.twoFactorAssertedAt === null) {
      throw twoFactorRequired();
    }

    const assertedAt = Date.parse(principal.twoFactorAssertedAt);
    // An unparseable timestamp fails CLOSED. Every comparison against NaN is
    // false, so an arithmetic check alone would silently ADMIT the request.
    if (Number.isNaN(assertedAt)) {
      throw twoFactorRequired();
    }

    const age = this.clock.now().getTime() - assertedAt;
    if (age > this.policy.twoFactorFreshnessMs) {
      throw twoFactorRequired();
    }

    // A timestamp in the future is a clock-skew artefact or a forged principal.
    // Either way it must not extend the freshness window indefinitely.
    if (age < -this.policy.twoFactorFreshnessMs) {
      throw twoFactorRequired();
    }
  }
}
