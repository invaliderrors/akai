import "reflect-metadata";
import {
  ExecutionContext,
  ForbiddenException,
  RequestMethod,
  UnauthorizedException,
} from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import type { Role } from "@akai/contracts";
import {
  AdminProductsController,
  reportSanitizedContent,
  type HeaderSink,
} from "./admin-products.controller";
import { CONTENT_SANITIZED_HEADER } from "./catalog.constants";
import type { ProductWriteResult } from "./products.service";
import { ProductsController } from "./products.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { DEFAULT_AUTH_POLICY } from "../auth/auth.policy";
import type { Clock } from "../auth/ports/clock.port";
import { PRINCIPAL_REQUEST_KEY, type Principal } from "../auth/security/principal";

/**
 * The guard under test is the CANONICAL RolesGuard, not a catalog-local copy.
 *
 * This suite originally exercised `CatalogRolesGuard`, one of five parallel
 * role-guard implementations. They have been consolidated onto
 * modules/auth/guards/roles.guard.ts, because five guards enforcing "is this
 * caller an admin" WILL drift, and a divergence between them is an
 * authorisation bypass that no single module's tests can see. Re-pointing this
 * suite is what proves the consolidation preserved the catalog's guarantees.
 */
const NOW = new Date("2026-07-20T12:00:00.000Z");
const clock: Clock = { now: () => NOW };

function newGuard(): RolesGuard {
  return new RolesGuard(new Reflector(), DEFAULT_AUTH_POLICY, clock);
}

/**
 * Spec §8 requires: "a CUSTOMER token hitting EVERY /admin/* route gets 403."
 *
 * The literal reading — write one test per endpoint — decays the moment someone
 * adds an endpoint, because the new one has no test and the suite still passes.
 * This DISCOVERS the routes by reflection instead, so a handler added tomorrow
 * is covered by a test written today, and an unannotated one fails immediately.
 */
function routeHandlersOf(controller: new (...args: never[]) => object): string[] {
  // `.prototype` is `any` on a constructor SIGNATURE type — TypeScript only
  // declares it on `Function`/class declarations — so this is captured as
  // `unknown` and narrowed rather than assigned straight into an `object`.
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
      // Only members carrying an HTTP path are routes; helpers are not.
      return isRouteHandler(value) && Reflect.hasMetadata(PATH_METADATA, value);
    });
}

/**
 * A route handler, typed as callable rather than as `object`, because
 * `Reflector.getAllAndOverride` accepts `Type | Function` targets.
 */
type RouteHandler = (...args: never[]) => unknown;

/**
 * A type predicate rather than an `as` assertion.
 *
 * `descriptor.value` is `any`, so it is first widened to `unknown` and then
 * narrowed by a declared predicate. "It is a function" genuinely establishes
 * callability, which is the only property the Reflector needs — so this is a
 * real check, not a cast dressed up as one.
 */
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
    // Without this the guard short-circuits on its non-HTTP escape hatch and
    // returns true for every case, so the whole suite would pass vacuously.
    getType: () => "http",
    getHandler: () => handlerOf(controller, handlerName),
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * A request carrying the given role, attached where JwtAuthGuard attaches it.
 *
 * `twoFactorAssertedAt` is fresh relative to the injected clock: the canonical
 * guard applies a step-up requirement to elevated routes, so a STAFF principal
 * with a stale second factor is correctly refused. Pinning it to NOW keeps
 * these cases testing ROLE authorisation rather than 2FA freshness, which the
 * auth module's own suite covers.
 */
function requestFor(role: Role): Record<string, unknown> {
  const principal: Principal = {
    customerId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    role,
    twoFactorAssertedAt: NOW.toISOString(),
  };
  return { [PRINCIPAL_REQUEST_KEY]: principal };
}

const ADMIN_ROUTES = routeHandlersOf(AdminProductsController);

describe("AdminProductsController authorisation", () => {
  /**
   * Guards the guard-test itself.
   *
   * If the reflection above ever stops finding handlers — a Nest metadata key
   * rename, a decorator change — every `it.each` below would iterate an empty
   * array and the suite would report success while asserting nothing. That
   * failure mode is worse than no test, so the discovery is asserted first.
   */
  it("discovers the admin routes it claims to be testing", () => {
    expect(ADMIN_ROUTES.length).toBeGreaterThanOrEqual(15);
    expect(ADMIN_ROUTES).toContain("create");
    expect(ADMIN_ROUTES).toContain("remove");
    expect(ADMIN_ROUTES).toContain("adjustInventory");
  });

  it.each(ADMIN_ROUTES)("denies CUSTOMER on %s with 403", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminProductsController, handlerName, requestFor("CUSTOMER"));

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it.each(ADMIN_ROUTES)("denies anonymous callers on %s with 401", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminProductsController, handlerName, {});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it.each(ADMIN_ROUTES)("permits STAFF on %s", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminProductsController, handlerName, requestFor("STAFF"));

    expect(guard.canActivate(context)).toBe(true);
  });

  it.each(ADMIN_ROUTES)("permits ADMIN on %s", (handlerName) => {
    const guard = newGuard();
    const context = contextFor(AdminProductsController, handlerName, requestFor("ADMIN"));

    expect(guard.canActivate(context)).toBe(true);
  });

  /**
   * The admin controller must never be marked @Public. A single stray decorator
   * would take the whole surface out from behind the global auth guard, and the
   * role guard above would then be the only thing left — which only runs if the
   * request reaches it.
   */
  it.each(ADMIN_ROUTES)("does not mark %s as @Public", (handlerName) => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      handlerOf(AdminProductsController, handlerName),
      AdminProductsController,
    ]);

    expect(isPublic).not.toBe(true);
  });
});

describe("ProductsController exposure", () => {
  const publicRoutes = routeHandlersOf(ProductsController);

  it("discovers the public routes it claims to be testing", () => {
    expect(publicRoutes).toEqual(
      expect.arrayContaining(["list", "listAddOns", "detail"]),
    );
  });

  it.each(publicRoutes)("marks %s as @Public", (handlerName) => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      handlerOf(ProductsController, handlerName),
      ProductsController,
    ]);

    expect(isPublic).toBe(true);
  });

  /**
   * The public controller must carry NO mutating verb. Catching this by
   * reflection rather than by review means a POST added here fails CI instead
   * of relying on someone noticing the file it landed in.
   *
   * THIS ASSERTED A HANDLER COUNT UNTIL THE ADD-ON ROUTE LANDED, and a count
   * was the wrong tripwire in both directions: it failed on a perfectly
   * legitimate third READ, and it would have passed unchanged if someone had
   * swapped one of the existing GETs for a POST. Reading the verb off each
   * handler tests the property the comment above actually claims, and a new
   * read no longer requires editing a number nobody can justify from the test
   * name alone.
   */
  it.each(publicRoutes)("exposes %s as a GET, never a mutating verb", (handlerName) => {
    const method: unknown = Reflect.getMetadata(
      METHOD_METADATA,
      handlerOf(ProductsController, handlerName),
    );

    expect(method).toBe(RequestMethod.GET);
  });
});

// ---------------------------------------------------------------------------
// Reporting a write the API altered
// ---------------------------------------------------------------------------

/**
 * A recording response, typed rather than cast.
 *
 * `HeaderSink` is the narrow slice the reporter needs, and express's `Response`
 * is structurally assignable to it — so this double is honest about what it
 * stands in for instead of pretending to be a whole HTTP response.
 */
function headerSink(): HeaderSink & { readonly headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name: string, value: string): void {
      headers.set(name, value);
    },
  };
}

/** The `Product` body is irrelevant here; only the header decision is under test. */
function writeResult(descriptionSanitized: boolean): ProductWriteResult {
  const product = productFixture();
  return { product, descriptionSanitized };
}

function productFixture(): ProductWriteResult["product"] {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "camiseta",
    status: "ACTIVE",
    taxClass: "STANDARD",
    name: "Camiseta",
    shortDescription: "",
    description: "",
    variants: [],
    media: [],
    categories: [],
    addOns: [],
    restrictedCountries: [],
    listed: true,
    offerOnNewProducts: false,
    newProductDefaultVariantId: null,
    stackDiscountEnabled: false,
    kind: "SIMPLE",
    packComponents: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("reportSanitizedContent", () => {
  /**
   * An operator who pastes a <script>, gets a 200 and watches the markup vanish
   * has learned nothing — least of all that the store was protected. The header
   * is the API saying out loud that it stored something other than what it was
   * given.
   */
  it("names the field whose copy was rewritten", () => {
    const response = headerSink();

    reportSanitizedContent(writeResult(true), response);

    expect(response.headers.get(CONTENT_SANITIZED_HEADER)).toBe("description");
  });

  /**
   * ABSENCE is the "nothing changed" case. Emitting an empty or falsy value
   * would give a client a warning-shaped thing to misread on every clean write.
   */
  it("sets no header at all when nothing was altered", () => {
    const response = headerSink();

    reportSanitizedContent(writeResult(false), response);

    expect(response.headers.has(CONTENT_SANITIZED_HEADER)).toBe(false);
  });

  it("returns the product unchanged, so the body stays the resource", () => {
    const result = writeResult(true);

    expect(reportSanitizedContent(result, headerSink())).toBe(result.product);
  });
});

