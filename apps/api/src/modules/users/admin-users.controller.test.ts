import "reflect-metadata";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AdminUsersController } from "./admin-users.controller";
import { UsersController } from "./users.controller";
import { AddressesController } from "./addresses.controller";
import { PRINCIPAL_REQUEST_KEY, type Principal } from "../auth/security/principal";
import { RolesGuard } from "../auth/guards/roles.guard";
import { DEFAULT_AUTH_POLICY } from "../auth/auth.policy";
import { systemClock } from "../auth/ports/clock.port";

/**
 * Exercises the CANONICAL RolesGuard, not a users-local copy.
 *
 * This module shipped a provisional guard with identical semantics while
 * AuthModule was a placeholder. Both are now the same class, so this suite
 * doubles as the proof that consolidating them preserved the 2FA step-up and
 * role checks it was written to pin down.
 *
 * `systemClock` rather than a frozen clock, because the fixtures below express
 * freshness as `new Date().toISOString()` — a stopped clock would make "fresh"
 * mean "fresh as of an arbitrary constant" and silently invert those cases.
 */
function newGuard(): RolesGuard {
  return new RolesGuard(new Reflector(), DEFAULT_AUTH_POLICY, systemClock);
}

/**
 * Spec §8's named acceptance test: a CUSTOMER hitting EVERY `/admin/*` route
 * gets 403.
 *
 * The routes are enumerated by REFLECTION over the controller prototype rather
 * than listed by hand. A hand-written list is a list of the routes someone
 * remembered — it silently stops covering the endpoint added next week, which is
 * exactly the endpoint most likely to be unprotected. This version fails the
 * moment an unguarded method appears on the class.
 *
 * A real `Reflector` reads the real decorator metadata, so this exercises the
 * actual `@Roles("STAFF","ADMIN")` on AdminUsersController, not a restatement
 * of it.
 */

function routeMethodsOf(target: new (...args: never[]) => object): readonly string[] {
  return Object.getOwnPropertyNames(target.prototype).filter(
    (name) => name !== "constructor",
  );
}

function contextFor(
  target: new (...args: never[]) => object,
  methodName: string,
  principal: Principal | null,
): ExecutionContext {
  // `.prototype` is `any` on a constructor SIGNATURE type, so it is captured as
  // `unknown` and narrowed instead of being assigned straight into an `object`.
  const candidate: unknown = target.prototype;
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError(`${methodName}: controller has no prototype`);
  }
  const prototype: object = candidate;
  const handler: unknown = Reflect.get(prototype, methodName);
  const request: Record<string, unknown> = {};
  if (principal !== null) {
    request[PRINCIPAL_REQUEST_KEY] = principal;
  }

  return {
    // Required: the guard returns true immediately for non-HTTP contexts, so
    // omitting this would make every assertion below pass vacuously.
    getType: () => "http",
    getHandler: () => handler,
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const customer: Principal = {
  customerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  role: "CUSTOMER",
  // Fresh 2FA, deliberately. The rejection below must come from the ROLE check;
  // a customer who happened to have 2FA enabled must still be refused.
  twoFactorAssertedAt: new Date().toISOString(),
};

describe("admin route authorisation", () => {
  const guard = newGuard();
  const adminRoutes = routeMethodsOf(AdminUsersController);

  it("declares at least one admin route (guards against a vacuous suite)", () => {
    // Without this, deleting every method from the controller would make the
    // loop below iterate zero times and report success.
    expect(adminRoutes.length).toBeGreaterThan(0);
  });

  it.each(adminRoutes)("refuses a CUSTOMER on AdminUsersController.%s", (method) => {
    expect(() => guard.canActivate(contextFor(AdminUsersController, method, customer))).toThrow(
      ForbiddenException,
    );
  });

  it.each(adminRoutes)("refuses an anonymous caller on AdminUsersController.%s", (method) => {
    expect(() => guard.canActivate(contextFor(AdminUsersController, method, null))).toThrow(
      UnauthorizedException,
    );
  });

  it.each(adminRoutes)(
    "refuses a STAFF principal without fresh 2FA on AdminUsersController.%s",
    (method) => {
      const staleStaff: Principal = {
        ...customer,
        role: "STAFF",
        twoFactorAssertedAt: null,
      };
      expect(() =>
        guard.canActivate(contextFor(AdminUsersController, method, staleStaff)),
      ).toThrow(ForbiddenException);
    },
  );

  it.each(adminRoutes)("admits an ADMIN with fresh 2FA on AdminUsersController.%s", (method) => {
    const admin: Principal = {
      ...customer,
      role: "ADMIN",
      twoFactorAssertedAt: new Date().toISOString(),
    };
    expect(guard.canActivate(contextFor(AdminUsersController, method, admin))).toBe(true);
  });
});

/**
 * The mirror assertion: customer-facing routes must NOT be admin-gated.
 *
 * A guard that rejected everything would pass every test above. This proves the
 * gate discriminates rather than merely denying.
 */
describe("customer route authorisation", () => {
  const guard = newGuard();
  const customerRoutes = [
    ...routeMethodsOf(UsersController).map(
      (method) => [UsersController, method] as const,
    ),
    ...routeMethodsOf(AddressesController).map(
      (method) => [AddressesController, method] as const,
    ),
  ];

  it.each(customerRoutes)("admits an authenticated CUSTOMER on %s.%s", (target, method) => {
    expect(guard.canActivate(contextFor(target, method, customer))).toBe(true);
  });

  it.each(customerRoutes)("still refuses an anonymous caller on %s.%s", (target, method) => {
    expect(() => guard.canActivate(contextFor(target, method, null))).toThrow(
      UnauthorizedException,
    );
  });
});
