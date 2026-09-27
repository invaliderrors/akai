import "reflect-metadata";
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import type { Role } from "@akai/contracts";
import { AdminBlogController } from "./admin-blog.controller";
import { BlogController } from "./blog.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { DEFAULT_AUTH_POLICY } from "../auth/auth.policy";
import type { Clock } from "../auth/ports/clock.port";
import { PRINCIPAL_REQUEST_KEY, type Principal } from "../auth/security/principal";
import { PATH_METADATA } from "@nestjs/common/constants";

/**
 * The blog controllers' authorisation surface.
 *
 * Same discovery-by-reflection approach as `admin-categories.controller.test.ts`:
 * every route handler on `AdminBlogController` is found by reflection, so a
 * handler added later is covered without anyone remembering to add a test —
 * and it inherits the class-level `@Roles("STAFF", "ADMIN")` for the same
 * reason. The public controller is checked the other way round: every handler
 * IS `@Public`, and nothing on it writes.
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

const ADMIN_ROUTES = routeHandlersOf(AdminBlogController);
const PUBLIC_ROUTES = routeHandlersOf(BlogController);

describe("AdminBlogController authorisation", () => {
  it("discovers the admin blog routes it claims to be testing", () => {
    expect(ADMIN_ROUTES).toEqual(
      expect.arrayContaining([
        "list",
        "get",
        "create",
        "update",
        "publish",
        "unpublish",
        "remove",
        "createCoverUploadUrl",
      ]),
    );
  });

  it.each(ADMIN_ROUTES)("denies CUSTOMER on %s with 403", (handlerName) => {
    const context = contextFor(AdminBlogController, handlerName, requestFor("CUSTOMER"));

    expect(() => newGuard().canActivate(context)).toThrow(ForbiddenException);
  });

  it.each(ADMIN_ROUTES)("denies PARTNER on %s with 403", (handlerName) => {
    const context = contextFor(AdminBlogController, handlerName, requestFor("PARTNER"));

    expect(() => newGuard().canActivate(context)).toThrow(ForbiddenException);
  });

  it.each(ADMIN_ROUTES)("denies anonymous callers on %s with 401", (handlerName) => {
    const context = contextFor(AdminBlogController, handlerName, {});

    expect(() => newGuard().canActivate(context)).toThrow(UnauthorizedException);
  });

  it.each(ADMIN_ROUTES)("permits STAFF and ADMIN on %s", (handlerName) => {
    for (const role of ["STAFF", "ADMIN"] as const) {
      const context = contextFor(AdminBlogController, handlerName, requestFor(role));
      expect(newGuard().canActivate(context)).toBe(true);
    }
  });

  it.each(ADMIN_ROUTES)("does not mark %s as @Public", (handlerName) => {
    const isPublic = new Reflector().getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      handlerOf(AdminBlogController, handlerName),
      AdminBlogController,
    ]);

    expect(isPublic).not.toBe(true);
  });
});

describe("BlogController (public)", () => {
  it("exposes exactly the two reads", () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual(["get", "list"]);
  });

  it.each(PUBLIC_ROUTES)("marks %s @Public so an anonymous shopper can read it", (handlerName) => {
    const isPublic = new Reflector().getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      handlerOf(BlogController, handlerName),
      BlogController,
    ]);

    expect(isPublic).toBe(true);
    expect(newGuard().canActivate(contextFor(BlogController, handlerName, {}))).toBe(true);
  });
});
