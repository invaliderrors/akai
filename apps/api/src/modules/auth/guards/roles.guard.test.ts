import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { Role } from "@akai/contracts";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { DEFAULT_AUTH_POLICY } from "../auth.policy";
import type { Clock } from "../ports/clock.port";
import { PRINCIPAL_REQUEST_KEY, type Principal } from "../security/principal";
import { ROLES_KEY, RolesGuard } from "./roles.guard";

/**
 * Authorisation-boundary tests.
 *
 * The headline requirement from spec §8 — "a CUSTOMER token hitting EVERY
 * /admin/* route gets 403" — is a property of this guard, so it is asserted
 * here directly rather than route by route.
 */

const NOW = new Date("2026-07-20T12:00:00.000Z");
const clock: Clock = { now: () => NOW };

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    customerId: randomUUID(),
    sessionId: randomUUID(),
    role: "CUSTOMER",
    twoFactorAssertedAt: null,
    ...overrides,
  };
}

/**
 * A minimal ExecutionContext.
 *
 * Built by hand rather than mocked: `getAllAndOverride` reads metadata from the
 * handler and class references, so supplying real functions with real metadata
 * exercises the same Reflector path production uses.
 */
function contextFor(options: {
  attached?: Principal | undefined;
  roles?: readonly Role[] | undefined;
  isPublic?: boolean;
  contextType?: string;
}): { context: ExecutionContext; reflector: Reflector } {
  const handler = (): void => undefined;
  class Controller {}

  if (options.roles !== undefined) {
    Reflect.defineMetadata(ROLES_KEY, options.roles, handler);
  }
  if (options.isPublic === true) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }

  const request: Record<string, unknown> = {};
  if (options.attached !== undefined) {
    request[PRINCIPAL_REQUEST_KEY] = options.attached;
  }

  const context = {
    getType: () => options.contextType ?? "http",
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;

  return { context, reflector: new Reflector() };
}

function guardFor(reflector: Reflector): RolesGuard {
  return new RolesGuard(reflector, DEFAULT_AUTH_POLICY, clock);
}

describe("RolesGuard — authentication precedence", () => {
  it("rejects an anonymous request with 401, not 403", () => {
    const { context, reflector } = contextFor({ roles: ["ADMIN"] });

    // 403 would confirm the route exists and hint at what it guards. The
    // ordering here is the control.
    expect(() => guardFor(reflector).canActivate(context)).toThrow(UnauthorizedException);
  });

  it("allows a public route with no principal at all", () => {
    const { context, reflector } = contextFor({ isPublic: true, roles: ["ADMIN"] });
    expect(guardFor(reflector).canActivate(context)).toBe(true);
  });

  it("allows any authenticated principal when no @Roles is present", () => {
    // Absence of @Roles means "authenticated", never "anyone" — handlers still
    // scope their queries by principal.customerId.
    const { context, reflector } = contextFor({ attached: principal() });
    expect(guardFor(reflector).canActivate(context)).toBe(true);
  });

  it("ignores non-HTTP contexts", () => {
    const { context, reflector } = contextFor({ contextType: "rpc" });
    expect(guardFor(reflector).canActivate(context)).toBe(true);
  });
});

describe("RolesGuard — the CUSTOMER-cannot-reach-admin requirement", () => {
  it("gives a CUSTOMER 403 on every elevated role combination", () => {
    // Spec §8's explicit acceptance test, applied to each way an admin route
    // can be declared.
    for (const roles of [["ADMIN"], ["STAFF"], ["STAFF", "ADMIN"]] as const) {
      const { context, reflector } = contextFor({
        attached: principal({ role: "CUSTOMER", twoFactorAssertedAt: NOW.toISOString() }),
        roles,
      });

      expect(() => guardFor(reflector).canActivate(context)).toThrow(ForbiddenException);
    }
  });

  it("gives a STAFF principal 403 on an ADMIN-only route", () => {
    const { context, reflector } = contextFor({
      attached: principal({ role: "STAFF", twoFactorAssertedAt: NOW.toISOString() }),
      roles: ["ADMIN"],
    });

    expect(() => guardFor(reflector).canActivate(context)).toThrow(ForbiddenException);
  });

  it("admits an ADMIN with a fresh second factor", () => {
    const { context, reflector } = contextFor({
      attached: principal({ role: "ADMIN", twoFactorAssertedAt: NOW.toISOString() }),
      roles: ["ADMIN"],
    });

    expect(guardFor(reflector).canActivate(context)).toBe(true);
  });
});

describe("RolesGuard — two-factor step-up", () => {
  it("refuses an ADMIN whose session never proved a second factor", () => {
    const { context, reflector } = contextFor({
      attached: principal({ role: "ADMIN", twoFactorAssertedAt: null }),
      roles: ["ADMIN"],
    });

    // This is what makes 2FA mandatory for ADMIN in practice, while still
    // leaving the enrolment endpoints (which carry no @Roles) reachable.
    expect(() => guardFor(reflector).canActivate(context)).toThrow(ForbiddenException);
  });

  it("refuses an ADMIN whose assertion has gone stale", () => {
    const stale = new Date(NOW.getTime() - DEFAULT_AUTH_POLICY.twoFactorFreshnessMs - 1_000);
    const { context, reflector } = contextFor({
      attached: principal({ role: "ADMIN", twoFactorAssertedAt: stale.toISOString() }),
      roles: ["ADMIN"],
    });

    // An unattended laptop that proved 2FA eight hours ago has proved nothing
    // about who is sending this request.
    expect(() => guardFor(reflector).canActivate(context)).toThrow(ForbiddenException);
  });

  it("admits an ADMIN just inside the freshness window", () => {
    const recent = new Date(NOW.getTime() - DEFAULT_AUTH_POLICY.twoFactorFreshnessMs + 1_000);
    const { context, reflector } = contextFor({
      attached: principal({ role: "ADMIN", twoFactorAssertedAt: recent.toISOString() }),
      roles: ["ADMIN"],
    });

    expect(guardFor(reflector).canActivate(context)).toBe(true);
  });

  it("does NOT demand step-up on a customer-scoped route", () => {
    // An admin reading their own profile through a customer route should not be
    // forced through a TOTP prompt: the step-up follows the ROUTE, not the
    // principal.
    const { context, reflector } = contextFor({
      attached: principal({ role: "ADMIN", twoFactorAssertedAt: null }),
    });

    expect(guardFor(reflector).canActivate(context)).toBe(true);
  });

  it("fails closed on an unparseable assertion timestamp", () => {
    const { context, reflector } = contextFor({
      attached: principal({ role: "ADMIN", twoFactorAssertedAt: "not-a-date" }),
      roles: ["ADMIN"],
    });

    // 401, not 403: `readPrincipal` parses with zod first, and "not-a-date"
    // fails `isoDateTimeSchema`, so the principal is discarded entirely before
    // the freshness check is ever reached. Two independent layers therefore
    // reject this — the schema here, and the explicit NaN check inside
    // assertFreshTwoFactor for any future caller that builds a Principal
    // directly rather than through readPrincipal. What matters for security is
    // only that it fails CLOSED, which this asserts.
    expect(() => guardFor(reflector).canActivate(context)).toThrow(UnauthorizedException);
  });

  it("fails closed on an assertion timestamp far in the future", () => {
    const future = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const { context, reflector } = contextFor({
      attached: principal({ role: "ADMIN", twoFactorAssertedAt: future.toISOString() }),
      roles: ["ADMIN"],
    });

    expect(() => guardFor(reflector).canActivate(context)).toThrow(ForbiddenException);
  });
});

describe("RolesGuard — principal integrity", () => {
  it("treats a malformed principal as unauthenticated", () => {
    const handler = (): void => undefined;
    class Controller {}
    Reflect.defineMetadata(ROLES_KEY, ["ADMIN"], handler);

    // Role is not a member of the enum: zod rejects it, readPrincipal returns
    // null, and the request fails closed rather than being partially trusted.
    const request = {
      [PRINCIPAL_REQUEST_KEY]: {
        customerId: randomUUID(),
        sessionId: randomUUID(),
        role: "SUPERADMIN",
        twoFactorAssertedAt: null,
      },
    };

    const context = {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    expect(() => new RolesGuard(new Reflector(), DEFAULT_AUTH_POLICY, clock).canActivate(context)).toThrow(
      UnauthorizedException,
    );
  });

  it("treats a principal with an injected extra field as unauthenticated", () => {
    const handler = (): void => undefined;
    class Controller {}
    Reflect.defineMetadata(ROLES_KEY, ["ADMIN"], handler);

    // principalSchema is .strict(): a smuggled field invalidates the whole
    // principal rather than being quietly dropped.
    const request = {
      [PRINCIPAL_REQUEST_KEY]: {
        customerId: randomUUID(),
        sessionId: randomUUID(),
        role: "ADMIN",
        twoFactorAssertedAt: NOW.toISOString(),
        impersonating: "someone-else",
      },
    };

    const context = {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    expect(() => new RolesGuard(new Reflector(), DEFAULT_AUTH_POLICY, clock).canActivate(context)).toThrow(
      UnauthorizedException,
    );
  });
});
