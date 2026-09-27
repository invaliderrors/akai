import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import type { AuthService } from "../auth.service";
import type { AuthenticatedUser } from "../auth.types";
import { readPrincipal } from "../security/principal";
import { JwtAuthGuard, extractBearerToken } from "./jwt-auth.guard";

const USER: AuthenticatedUser = {
  customerId: randomUUID(),
  sessionId: randomUUID(),
  role: "CUSTOMER",
  email: "cliente@akai.shop",
  emailVerified: true,
  twoFactorAssertedAt: null,
};

/**
 * A stand-in for AuthService exposing only `authenticate`.
 *
 * Typed through a structural interface rather than a cast: the guard's declared
 * dependency is the whole service, so the double is widened at the single point
 * of construction instead of sprinkling `as` through the tests.
 */
function serviceStub(
  authenticate: (token: string) => Promise<AuthenticatedUser | null>,
): AuthService {
  const stub: Pick<AuthService, "authenticate"> = { authenticate };
  return stub as AuthService;
}

function contextFor(options: {
  authorization?: string | string[] | undefined;
  isPublic?: boolean;
  contextType?: string;
}): { context: ExecutionContext; request: Record<string, unknown> } {
  const handler = (): void => undefined;
  class Controller {}

  if (options.isPublic === true) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }

  const headers: Record<string, unknown> = {};
  if (options.authorization !== undefined) {
    headers["authorization"] = options.authorization;
  }
  const request: Record<string, unknown> = { headers };

  const context = {
    getType: () => options.contextType ?? "http",
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe("extractBearerToken", () => {
  it("accepts a well-formed header, case-insensitively", () => {
    expect(extractBearerToken({ headers: { authorization: "Bearer abc.def.ghi" } })).toBe(
      "abc.def.ghi",
    );
    expect(extractBearerToken({ headers: { authorization: "bearer abc" } })).toBe("abc");
  });

  it("rejects anything malformed rather than guessing", () => {
    // Parser-differential bugs start here: a lenient reader disagrees with the
    // proxy in front of it about which substring is the credential.
    for (const header of [
      "abc",
      "Basic abc",
      "Bearer",
      "Bearer ",
      "Bearer a b",
      "Token abc",
      "",
    ]) {
      expect(extractBearerToken({ headers: { authorization: header } })).toBeNull();
    }
  });

  it("rejects a repeated header, which Node models as an array", () => {
    expect(
      extractBearerToken({ headers: { authorization: ["Bearer a", "Bearer b"] } }),
    ).toBeNull();
  });

  it("returns null for a request with no headers at all", () => {
    expect(extractBearerToken({})).toBeNull();
    expect(extractBearerToken({ headers: null })).toBeNull();
  });
});

describe("JwtAuthGuard", () => {
  it("attaches the principal for a valid token", async () => {
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(() => Promise.resolve(USER)));
    const { context, request } = contextFor({ authorization: "Bearer valid-token" });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const principal = readPrincipal(request);
    expect(principal?.customerId).toBe(USER.customerId);
    expect(principal?.role).toBe("CUSTOMER");
  });

  it("rejects a request with no Authorization header", async () => {
    const authenticate = vi.fn(() => Promise.resolve(USER));
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(authenticate));
    const { context } = contextFor({});

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    // Short-circuits before touching the database.
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects a token the service refuses", async () => {
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(() => Promise.resolve(null)));
    const { context } = contextFor({ authorization: "Bearer revoked-token" });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("gives the same message for a missing and an invalid token", async () => {
    const missing = await new JwtAuthGuard(
      new Reflector(),
      serviceStub(() => Promise.resolve(null)),
    )
      .canActivate(contextFor({}).context)
      .catch((error: unknown) => error);

    const invalid = await new JwtAuthGuard(
      new Reflector(),
      serviceStub(() => Promise.resolve(null)),
    )
      .canActivate(contextFor({ authorization: "Bearer nope" }).context)
      .catch((error: unknown) => error);

    // Expired, forged, revoked session, deleted customer — all one response.
    expect((missing as Error).message).toBe((invalid as Error).message);
  });

  it("leaves no principal attached when authentication fails", async () => {
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(() => Promise.resolve(null)));
    const { context, request } = contextFor({ authorization: "Bearer nope" });

    await guard.canActivate(context).catch(() => undefined);
    expect(readPrincipal(request)).toBeNull();
  });
});

describe("JwtAuthGuard — public routes", () => {
  it("allows an anonymous request through", async () => {
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(() => Promise.resolve(null)));
    const { context, request } = contextFor({ isPublic: true });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(readPrincipal(request)).toBeNull();
  });

  it("still resolves a principal when a valid token IS presented", async () => {
    // Lets a public endpoint personalise itself (a cart that knows your saved
    // address) without becoming an authenticated route.
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(() => Promise.resolve(USER)));
    const { context, request } = contextFor({
      isPublic: true,
      authorization: "Bearer valid-token",
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(readPrincipal(request)?.customerId).toBe(USER.customerId);
  });

  it("stays anonymous rather than 401ing when a public route gets a bad token", async () => {
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(() => Promise.resolve(null)));
    const { context, request } = contextFor({
      isPublic: true,
      authorization: "Bearer expired-token",
    });

    // A shopper whose session quietly expired must still be able to browse.
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(readPrincipal(request)).toBeNull();
  });
});

describe("JwtAuthGuard — principal immutability", () => {
  it("prevents anything downstream from swapping the principal", async () => {
    const guard = new JwtAuthGuard(new Reflector(), serviceStub(() => Promise.resolve(USER)));
    const { context, request } = contextFor({ authorization: "Bearer valid-token" });
    await guard.canActivate(context);

    // A handler or interceptor that could reassign this field would be an
    // authorisation bypass with no obvious signature in review.
    expect(() => {
      Object.assign(request, {
        akaiPrincipal: {
          customerId: randomUUID(),
          sessionId: randomUUID(),
          role: "ADMIN",
          twoFactorAssertedAt: new Date().toISOString(),
        },
      });
    }).toThrow();

    expect(readPrincipal(request)?.role).toBe("CUSTOMER");
  });
});
