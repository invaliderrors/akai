import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR, type Role } from "@akai/contracts";

import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { FREE_SHIPPING_THRESHOLD_MINOR } from "../../../seed/free-shipping-threshold";
import { DEFAULT_AUTH_POLICY } from "../../auth/auth.policy";
import { ROLES_KEY, RolesGuard } from "../../auth/guards/roles.guard";
import { PRINCIPAL_REQUEST_KEY } from "../../auth/security/principal";
import { AdminShippingController } from "./admin-shipping.controller";

/**
 * Authorisation of `/v1/admin/shipping/*`. The role list is asserted on the
 * class, AND every handler is run through the real RolesGuard as a CUSTOMER and
 * as STAFF — so a handler that grew its own `@Public()` or `@Roles()` override
 * would fail here, not in production.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");

const HANDLERS = [
  "listZones",
  "createZone",
  "updateZone",
  "deleteZone",
  "listRates",
  "createRate",
  "updateRate",
  "deleteRate",
] as const;

function contextFor(handler: (typeof HANDLERS)[number], role: Role): ExecutionContext {
  const request: Record<string, unknown> = {
    [PRINCIPAL_REQUEST_KEY]: {
      customerId: randomUUID(),
      sessionId: randomUUID(),
      role,
      twoFactorAssertedAt: NOW.toISOString(),
    },
  };
  const method: unknown = AdminShippingController.prototype[handler];
  return {
    getType: () => "http",
    getHandler: () => method,
    getClass: () => AdminShippingController,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe("AdminShippingController — authorisation", () => {
  const guard = new RolesGuard(new Reflector(), DEFAULT_AUTH_POLICY, { now: () => NOW });

  it("is STAFF/ADMIN at class level (the categories/discounts precedent)", () => {
    const roles: unknown = Reflect.getMetadata(ROLES_KEY, AdminShippingController);
    expect(roles).toEqual(["STAFF", "ADMIN"]);
  });

  it.each(HANDLERS)("%s refuses a CUSTOMER and admits STAFF and ADMIN", (handler) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminShippingController.prototype[handler])).toBe(
      undefined,
    );
    expect(() => guard.canActivate(contextFor(handler, "CUSTOMER"))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor(handler, "STAFF"))).toBe(true);
    expect(guard.canActivate(contextFor(handler, "ADMIN"))).toBe(true);
  });
});

describe("advertised free-shipping threshold", () => {
  // The dashboard warns when a rate's threshold differs from the advertised
  // figure; the seeds write FREE_SHIPPING_THRESHOLD_MINOR, itself pinned to the
  // storefront copy. All three must be one number.
  it("is the figure the seeds write", () => {
    expect(ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR).toBe(FREE_SHIPPING_THRESHOLD_MINOR);
  });
});
