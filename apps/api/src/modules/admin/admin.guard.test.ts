import "reflect-metadata";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@akai/contracts";
import { AdminGuard, TWO_FACTOR_FRESHNESS_MS } from "./admin.guard";
import { ADMIN_FRESH_2FA_KEY, ADMIN_ROLES_KEY } from "./admin.decorators";
import { PRINCIPAL_REQUEST_KEY } from "../auth/security/principal";
import type { AdminSessionReader, AdminSessionSnapshot } from "./admin.types";

/**
 * The authorisation boundary for the entire privileged surface.
 *
 * These tests are adversarial on purpose. Every case below is a way an admin
 * panel actually gets broken into: a stale token, a revoked session, a token
 * spliced onto someone else's session, an endpoint nobody remembered to
 * annotate. A guard is only worth what its negative tests prove.
 */

const NOW = new Date("2026-07-20T12:00:00.000Z");

function session(overrides: Partial<AdminSessionSnapshot> = {}): AdminSessionSnapshot {
  return {
    sessionId: "session-1",
    customerId: "customer-1",
    role: "ADMIN",
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + 60_000),
    twoFactorAssertedAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

interface ContextOptions {
  readonly user?: unknown;
  readonly roles?: readonly Role[];
  readonly freshTwoFactor?: boolean;
  readonly ip?: string;
  readonly userAgent?: string;
}

interface BuiltContext {
  readonly context: ExecutionContext;
  readonly request: Record<string, unknown>;
}

function buildContext(options: ContextOptions = {}): BuiltContext {
  const handler = function adminHandler(): void {};
  const controllerClass = class AdminController {};

  if (options.roles !== undefined) {
    Reflect.defineMetadata(ADMIN_ROLES_KEY, options.roles, handler);
  }
  if (options.freshTwoFactor === true) {
    Reflect.defineMetadata(ADMIN_FRESH_2FA_KEY, true, handler);
  }

  // Attached under the key JwtAuthGuard uses, NOT as `request.user`. The
  // principal moved when AuthModule landed; building the old shape here would
  // let this suite keep passing against a guard that reads nothing in
  // production.
  const request: Record<string, unknown> = {
    [PRINCIPAL_REQUEST_KEY]: options.user,
    ip: options.ip ?? "203.0.113.7",
    headers: { "user-agent": options.userAgent ?? "Mozilla/5.0" },
  };

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controllerClass,
  };

  // The ExecutionContext surface is far wider than a guard uses; only the three
  // members AdminGuard actually calls are implemented, and the object is passed
  // through a typed helper so the test never asserts a shape it did not build.
  return { context: context as unknown as ExecutionContext, request };
}

function buildGuard(reader: Partial<AdminSessionReader>): AdminGuard {
  const sessions: AdminSessionReader = {
    findActiveSession: reader.findActiveSession ?? (async () => null),
  };
  return new AdminGuard(new Reflector(), sessions);
}

const VALID_PRINCIPAL = { customerId: "customer-1", sessionId: "session-1" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AdminGuard — authentication", () => {
  it("rejects a request with no principal as 401, not 403", async () => {
    const guard = buildGuard({});
    const { context } = buildContext({ user: undefined, roles: ["ADMIN"] });

    // 401 vs 403 is not pedantry: the dashboard offers re-login on 401 and shows
    // "access denied" on 403. Getting it backwards strands a user with an
    // expired session on a dead-end screen.
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it.each([
    ["a string", "customer-1"],
    ["null", null],
    ["an object missing sessionId", { customerId: "customer-1" }],
    ["an object missing sub", { sessionId: "session-1" }],
    ["empty-string identifiers", { customerId: "", sessionId: "" }],
  ])("rejects a malformed principal (%s)", async (_label, user) => {
    const guard = buildGuard({});
    const { context } = buildContext({ user, roles: ["ADMIN"] });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects when the session row does not exist", async () => {
    const guard = buildGuard({ findActiveSession: async () => null });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: ["ADMIN"] });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a revoked session even though the token is still valid", async () => {
    const guard = buildGuard({
      findActiveSession: async () => session({ revokedAt: new Date(NOW.getTime() - 1000) }),
    });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: ["ADMIN"] });

    // Logging out must take effect immediately. If revocation only mattered at
    // token expiry, "log out all devices" would be advisory for up to 15 minutes.
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects an expired session", async () => {
    const guard = buildGuard({
      findActiveSession: async () => session({ expiresAt: new Date(NOW.getTime() - 1) }),
    });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: ["ADMIN"] });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a token spliced onto a session belonging to someone else", async () => {
    const guard = buildGuard({
      findActiveSession: async () => session({ customerId: "a-different-customer" }),
    });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: ["ADMIN"] });

    // The token names a session; the session names its owner. Disagreement means
    // the pair was assembled, not issued — reject rather than resolve in favour
    // of either side.
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});

describe("AdminGuard — authorisation", () => {
  it("denies a CUSTOMER every admin route with 403", async () => {
    const guard = buildGuard({ findActiveSession: async () => session({ role: "CUSTOMER" }) });

    // The spec's required test: a CUSTOMER hitting the admin surface gets 403
    // regardless of how the route is annotated.
    for (const roles of [["ADMIN"], ["STAFF"], ["STAFF", "ADMIN"]] as const) {
      const { context } = buildContext({ user: VALID_PRINCIPAL, roles: [...roles] });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    }
  });

  it("denies STAFF on an ADMIN-only route", async () => {
    const guard = buildGuard({ findActiveSession: async () => session({ role: "STAFF" }) });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: ["ADMIN"] });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it("allows STAFF on a route that opted down to STAFF", async () => {
    const guard = buildGuard({ findActiveSession: async () => session({ role: "STAFF" }) });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: ["STAFF", "ADMIN"] });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("defaults an UNANNOTATED route to ADMIN-only, not to open", async () => {
    const staffGuard = buildGuard({
      findActiveSession: async () => session({ role: "STAFF" }),
    });
    const { context: staffContext } = buildContext({ user: VALID_PRINCIPAL });

    // This is the fail-closed test. A developer adding an admin endpoint and
    // forgetting @AdminRoles must get a route that is too strict, never one that
    // is silently reachable by staff or customers.
    await expect(staffGuard.canActivate(staffContext)).rejects.toThrow(ForbiddenException);

    const adminGuard = buildGuard({ findActiveSession: async () => session() });
    const { context: adminContext } = buildContext({ user: VALID_PRINCIPAL });
    await expect(adminGuard.canActivate(adminContext)).resolves.toBe(true);
  });

  it("treats an EMPTY role annotation as ADMIN-only rather than as 'no restriction'", async () => {
    const guard = buildGuard({ findActiveSession: async () => session({ role: "STAFF" }) });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: [] });

    // `@AdminRoles()` with no arguments is a plausible typo. An empty allow-list
    // read as "allow everything" would be a silent privilege escalation.
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it("uses the DB role, IGNORING a stale elevated role in the token", async () => {
    const guard = buildGuard({ findActiveSession: async () => session({ role: "CUSTOMER" }) });
    const { context } = buildContext({
      // A token minted before the demotion still claims ADMIN.
      user: { ...VALID_PRINCIPAL, role: "ADMIN" },
      roles: ["ADMIN"],
    });

    // Spec §8: the role is re-read from the database on every request. If the
    // token were trusted, a demoted or compromised admin would keep full access
    // until their access token expired.
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});

describe("AdminGuard — step-up 2FA", () => {
  it("allows a step-up route when the assertion is fresh", async () => {
    const guard = buildGuard({ findActiveSession: async () => session() });
    const { context } = buildContext({
      user: VALID_PRINCIPAL,
      roles: ["ADMIN"],
      freshTwoFactor: true,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies a step-up route when 2FA was never asserted", async () => {
    const guard = buildGuard({
      findActiveSession: async () => session({ twoFactorAssertedAt: null }),
    });
    const { context } = buildContext({
      user: VALID_PRINCIPAL,
      roles: ["ADMIN"],
      freshTwoFactor: true,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it("denies a step-up route when the assertion has gone stale", async () => {
    const guard = buildGuard({
      findActiveSession: async () =>
        session({
          twoFactorAssertedAt: new Date(NOW.getTime() - TWO_FACTOR_FRESHNESS_MS - 1),
        }),
    });
    const { context } = buildContext({
      user: VALID_PRINCIPAL,
      roles: ["ADMIN"],
      freshTwoFactor: true,
    });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it("rejects a FUTURE-DATED assertion instead of treating it as maximally fresh", async () => {
    const guard = buildGuard({
      findActiveSession: async () =>
        session({ twoFactorAssertedAt: new Date(NOW.getTime() + 60_000) }),
    });
    const { context } = buildContext({
      user: VALID_PRINCIPAL,
      roles: ["ADMIN"],
      freshTwoFactor: true,
    });

    // A naive `now - assertedAt <= TTL` check passes for any future timestamp,
    // so a clock skew or a forged row would grant indefinite step-up access.
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it("does not require 2FA on routes that did not ask for it", async () => {
    const guard = buildGuard({
      findActiveSession: async () => session({ twoFactorAssertedAt: null }),
    });
    const { context } = buildContext({ user: VALID_PRINCIPAL, roles: ["ADMIN"] });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe("AdminGuard — actor propagation", () => {
  it("attaches an actor built from the DB session, not from the request", async () => {
    const guard = buildGuard({ findActiveSession: async () => session({ role: "STAFF" }) });
    const { context, request } = buildContext({
      user: { ...VALID_PRINCIPAL, role: "ADMIN" },
      roles: ["STAFF", "ADMIN"],
      ip: "198.51.100.4",
      userAgent: "AdminPanel/2.0",
    });

    await guard.canActivate(context);
    const actor = request["adminActor"];

    expect(actor).toMatchObject({
      customerId: "customer-1",
      sessionId: "session-1",
      // STAFF from the database, NOT the ADMIN the request claimed.
      role: "STAFF",
      ipAddress: "198.51.100.4",
      userAgent: "AdminPanel/2.0",
    });
    // Asserted structurally rather than with `expect.any(String)`: the repo's
    // no-any CI gate matches that matcher as a type escape hatch.
    expect(typeof (actor as { requestId: unknown }).requestId).toBe("string");
  });

  it("truncates an oversized user-agent to the audit column width", async () => {
    const guard = buildGuard({ findActiveSession: async () => session() });
    const { context, request } = buildContext({
      user: VALID_PRINCIPAL,
      roles: ["ADMIN"],
      userAgent: "x".repeat(2000),
    });

    await guard.canActivate(context);
    const actor = request["adminActor"];

    // Bounded at capture. An oversized header must never be able to fail the
    // INSERT of the audit row that depends on it.
    expect(actor).toMatchObject({ userAgent: "x".repeat(512) });
  });

  it("records a null IP rather than inventing one when Express reports none", async () => {
    const guard = buildGuard({ findActiveSession: async () => session() });
    const { context, request } = buildContext({ user: VALID_PRINCIPAL, roles: ["ADMIN"] });
    request["ip"] = undefined;

    await guard.canActivate(context);

    expect(request["adminActor"]).toMatchObject({ ipAddress: null });
  });
});
