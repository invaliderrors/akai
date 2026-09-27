import "reflect-metadata";
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import type { Role } from "@akai/contracts";
import { AdminCategoriesController } from "./admin-categories.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { DEFAULT_AUTH_POLICY } from "../auth/auth.policy";
import type { Clock } from "../auth/ports/clock.port";
import { PRINCIPAL_REQUEST_KEY, type Principal } from "../auth/security/principal";
import { PATH_METADATA } from "@nestjs/common/constants";

/**
 * `AdminCategoriesController`'s authorisation surface.
 *
 * Same discovery-by-reflection approach as `admin-products.controller.test.ts`
 * — see that file's own comment for why: writing one test per endpoint decays
 * the moment someone adds an endpoint, because the new one has no test and the
 * suite still passes regardless. This controller carries the class-level
 * `@Roles("STAFF", "ADMIN")` for the identical reason that one does — a new
 * handler inherits the restriction by default rather than needing its own
 * decorator remembered.
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
    twoFactorAssertedAt: NOW.toISOString(),
  };
  return { [PRINCIPAL_REQUEST_KEY]: principal };
}

const CATEGORY_ROUTES = routeHandlersOf(AdminCategoriesController);

describe("AdminCategoriesController authorisation", () => {
  it("discovers the admin category routes it claims to be testing", () => {
    expect(CATEGORY_ROUTES.length).toBeGreaterThanOrEqual(5);
    expect(CATEGORY_ROUTES).toEqual(
      expect.arrayContaining(["list", "create", "update", "reorder", "remove"]),
    );
  });

  it.each(CATEGORY_ROUTES)("denies CUSTOMER on %s with 403", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminCategoriesController, handlerName, requestFor("CUSTOMER"));

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it.each(CATEGORY_ROUTES)("denies anonymous callers on %s with 401", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminCategoriesController, handlerName, {});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it.each(CATEGORY_ROUTES)("permits STAFF on %s", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminCategoriesController, handlerName, requestFor("STAFF"));

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each(CATEGORY_ROUTES)("permits ADMIN on %s", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminCategoriesController, handlerName, requestFor("ADMIN"));

    expect(guard.canActivate(context)).toBe(true);
  });

  /**
   * A stray `@Public()` here would take the whole surface out from behind the
   * global auth guard, leaving the role guard above as the only thing left —
   * which only runs if the request reaches it at all.
   */
  it.each(CATEGORY_ROUTES)("does not mark %s as @Public", (handlerName) => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      handlerOf(AdminCategoriesController, handlerName),
      AdminCategoriesController,
    ]);

    expect(isPublic).not.toBe(true);
  });
});
