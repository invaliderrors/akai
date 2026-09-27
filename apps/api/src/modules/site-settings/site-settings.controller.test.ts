import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { SiteSettingsController } from "./site-settings.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";

/**
 * The public read must stay reachable with no session — it is
 * `apps/storefront/src/middleware.ts` deciding whether one exists yet — and
 * must never be a mutating verb, matching `ProductsController exposure`'s own
 * reasoning in `admin-products.controller.test.ts`.
 */
describe("SiteSettingsController exposure", () => {
  it("marks its one route @Public", () => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      SiteSettingsController.prototype.get,
      SiteSettingsController,
    ]);

    expect(isPublic).toBe(true);
  });

  it("exposes its one route as a GET, never a mutating verb", () => {
    const method: unknown = Reflect.getMetadata(
      METHOD_METADATA,
      SiteSettingsController.prototype.get,
    );

    expect(method).toBe(RequestMethod.GET);
  });
});
