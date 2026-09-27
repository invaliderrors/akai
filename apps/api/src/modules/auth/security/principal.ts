import {
  createParamDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import { z } from "zod";
import { idSchema, isoDateTimeSchema, roleSchema } from "@akai/contracts";
import { notAuthenticated } from "../auth.errors";
import type { AuthenticatedUser } from "../auth.types";

/**
 * THE authenticated principal. Canonical home (spec §8).
 *
 * `apps/api/src/modules/users/security/principal.ts` declared this shape
 * provisionally while AuthModule was a placeholder, and its own comment asks
 * for it to be deleted once AuthModule lands. This file is the replacement and
 * deliberately exposes an IDENTICAL surface — `principalSchema`, `Principal`,
 * `PRINCIPAL_REQUEST_KEY`, `readPrincipal`, `CurrentUser` — so that removing
 * the provisional copy is a pure import rewrite with no behaviour change. See
 * followUps.
 *
 * Two properties are load-bearing:
 *
 * 1. `role` is what AuthService read FROM THE DATABASE on this request, never a
 *    claim decoded from the JWT. JwtAuthGuard below is the code that makes that
 *    true, so a role revocation bites on the next request rather than in
 *    fifteen minutes when the access token expires.
 *
 * 2. `customerId` is the only accepted source of identity. No handler reads a
 *    customer id from a path param, query string or body — that is the whole
 *    IDOR defence.
 */
export const principalSchema = z
  .object({
    customerId: idSchema,
    sessionId: idSchema,
    role: roleSchema,
    /**
     * When the session last passed a TOTP challenge. Null means never.
     * Elevated routes require this to be RECENT, not merely present.
     */
    twoFactorAssertedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type Principal = z.infer<typeof principalSchema>;

/** Where JwtAuthGuard parks the principal on the request object. */
export const PRINCIPAL_REQUEST_KEY = "akaiPrincipal";

/** Narrows the internal, Date-bearing principal onto the wire-safe shape. */
export function toPrincipal(user: AuthenticatedUser): Principal {
  return {
    customerId: user.customerId,
    sessionId: user.sessionId,
    role: user.role,
    twoFactorAssertedAt: user.twoFactorAssertedAt?.toISOString() ?? null,
  };
}

/**
 * Pull the principal off a request, treating it as untrusted `unknown`.
 *
 * The request object comes from Express, so its type is a promise the framework
 * makes rather than one the compiler checks. Parsing with zod means a malformed
 * or absent principal fails closed (null -> 401) instead of producing an object
 * that satisfies the type but not reality — which is how `principal.customerId`
 * ends up `undefined` in a where clause that then matches every row.
 */
export function readPrincipal(request: unknown): Principal | null {
  if (typeof request !== "object" || request === null) {
    return null;
  }
  if (!(PRINCIPAL_REQUEST_KEY in request)) {
    return null;
  }
  const parsed = principalSchema.safeParse(request[PRINCIPAL_REQUEST_KEY]);
  return parsed.success ? parsed.data : null;
}

/** Attach a principal to the request. Called only by JwtAuthGuard. */
export function writePrincipal(request: object, principal: Principal): void {
  Object.defineProperty(request, PRINCIPAL_REQUEST_KEY, {
    value: principal,
    enumerable: false,
    configurable: true,
    // Non-writable: nothing downstream of the guard may swap the principal for
    // another one. An interceptor or handler that could reassign this field
    // would be an authorisation bypass with no obvious signature in review.
    writable: false,
  });
}

/**
 * `@CurrentUser()` — injects the authenticated principal into a handler.
 *
 * THROWS rather than returning null when unauthenticated. A nullable principal
 * would push a null check into every handler, and the one handler that forgets
 * it becomes an unauthenticated read of somebody's address book.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = readPrincipal(context.switchToHttp().getRequest<unknown>());
    if (principal === null) {
      throw notAuthenticated();
    }
    return principal;
  },
);
