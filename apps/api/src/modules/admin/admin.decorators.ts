import {
  SetMetadata,
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import type { Role } from "@akai/contracts";
import { narrowAdminActor, type AdminActor } from "./admin.types";

export const ADMIN_ROLES_KEY = "akai:adminRoles";
export const ADMIN_FRESH_2FA_KEY = "akai:adminFresh2fa";

/**
 * Declares which roles may reach a handler.
 *
 * When ABSENT, AdminGuard requires ADMIN — the most restrictive option, not the
 * most permissive. That default is the whole point: a new admin endpoint added
 * without thinking about authorisation fails closed for staff rather than
 * silently widening the privileged surface. Read-only dashboard endpoints opt
 * DOWN to STAFF explicitly, which is a visible, reviewable act.
 */
export const AdminRoles = (...roles: readonly Role[]): CustomDecorator<string> =>
  SetMetadata(ADMIN_ROLES_KEY, roles);

/**
 * Requires a recent 2FA assertion on the session row, over and above the role.
 *
 * Applied to destructive or bulk operations. A stolen session cookie is a real
 * threat model for an admin panel, and a step-up assertion is what stops one
 * from being immediately usable to rewrite the catalogue.
 */
export const RequireFreshTwoFactor = (): CustomDecorator<string> =>
  SetMetadata(ADMIN_FRESH_2FA_KEY, true);

/**
 * Injects the VERIFIED actor that AdminGuard attached to the request.
 *
 * Throws if it is missing rather than returning undefined: reaching a handler
 * with no actor means the guard did not run, and a handler that quietly
 * proceeds with an undefined actor is an unauthenticated admin mutation.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminActor => {
    const request: unknown = context.switchToHttp().getRequest();

    if (typeof request === "object" && request !== null && "adminActor" in request) {
      const actor = narrowAdminActor(request.adminActor);
      if (actor !== null) {
        return actor;
      }
    }
    throw new Error(
      "CurrentAdmin used on a handler that AdminGuard did not protect — refusing to run without a verified actor",
    );
  },
);
