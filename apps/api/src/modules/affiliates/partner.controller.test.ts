import "reflect-metadata";
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import type { Role } from "@akai/contracts";
import { PartnerController } from "./partner.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { DEFAULT_AUTH_POLICY } from "../auth/auth.policy";
import type { Clock } from "../auth/ports/clock.port";
import { PRINCIPAL_REQUEST_KEY, type Principal } from "../auth/security/principal";
import { PATH_METADATA } from "@nestjs/common/constants";

/**
 * `PartnerController`'s authorisation surface — an ALLOW-LIST
 * (`@Roles("PARTNER")` only), the deliberate opposite shape of
 * `route-policy.ts`'s dashboard-side deny-list gap this feature was built to
 * avoid repeating. Same discovery-by-reflection approach as
 * `admin-affiliates.controller.test.ts`.
 */
const NOW = new Date("2026-07-20T12:00:00.000Z");
const clock: Clock = { now: () => NOW };

function newGuard(): RolesGuard {
  return new RolesGuard(new Reflector(), DEFAULT_AUTH_POLICY, clock);
}

function routeHandlersOf(controller: new (...args: never[]) => object): string[] {
  const candidate: unknown = controller.prototype;
  if (typeof candidate !== "object" || candidate === null) {
    return [];
  }
  const prototype: object = candidate;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor === undefined) {
        return false;
      }
      const value: unknown = descriptor.value;
      return isRouteHandler(value) && Reflect.hasMetadata(PATH_METADATA, value);
    });
}

type RouteHandler = (...args: never[]) => unknown;

function isRouteHandler(value: unknown): value is RouteHandler {
  return typeof value === "function";
}

function handlerOf(
  controller: new (...args: never[]) => object,
  name: string,
): RouteHandler {
  const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, name);

  if (descriptor === undefined) {
    throw new Error(`Handler ${name} not found`);
  }

  const value: unknown = descriptor.value;
  if (!isRouteHandler(value)) {
    throw new Error(`Handler ${name} is not callable`);
  }

  return value;
}

function contextFor(
  controller: new (...args: never[]) => object,
  handlerName: string,
  request: unknown,
): ExecutionContext {
  return {
    getType: () => "http",
    getHandler: () => handlerOf(controller, handlerName),
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestFor(role: Role): Record<string, unknown> {
  const principal: Principal = {
    customerId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    role,
    twoFactorAssertedAt: null,
  };
  return { [PRINCIPAL_REQUEST_KEY]: principal };
}

const PARTNER_ROUTES = routeHandlersOf(PartnerController);

describe("PartnerController authorisation", () => {
  it("discovers the partner routes it claims to be testing", () => {
    expect(PARTNER_ROUTES).toEqual(expect.arrayContaining(["me"]));
  });

  it.each(PARTNER_ROUTES)("denies CUSTOMER on %s with 403", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(PartnerController, handlerName, requestFor("CUSTOMER"));

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it.each(PARTNER_ROUTES)("denies STAFF on %s with 403 — this is an allow-list, not a deny-list", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(PartnerController, handlerName, requestFor("STAFF"));

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it.each(PARTNER_ROUTES)("denies ADMIN on %s with 403 — an admin reads partner data through the admin routes, not this one", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(PartnerController, handlerName, requestFor("ADMIN"));

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it.each(PARTNER_ROUTES)("denies anonymous callers on %s with 401", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(PartnerController, handlerName, {});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it.each(PARTNER_ROUTES)("permits PARTNER on %s", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(PartnerController, handlerName, requestFor("PARTNER"));

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each(PARTNER_ROUTES)("requires no fresh two-factor for PARTNER on %s — this is a read-one-number account, not a privileged one", (handlerName) => {
    const guard = newGuard();
    const principal: Principal = {
      customerId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      role: "PARTNER",
      twoFactorAssertedAt: null,
    };
    const context = contextFor(PartnerController, handlerName, {
      [PRINCIPAL_REQUEST_KEY]: principal,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each(PARTNER_ROUTES)("does not mark %s as @Public", (handlerName) => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      handlerOf(PartnerController, handlerName),
      PartnerController,
    ]);

    expect(isPublic).not.toBe(true);
  });
});
