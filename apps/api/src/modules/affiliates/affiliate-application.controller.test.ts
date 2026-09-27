import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { AffiliateApplicationController } from "./affiliate-application.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";

/**
 * The public application form's one route must stay reachable with no
 * session — it is how an applicant reaches the platform at all — and must
 * be a POST, matching `SiteSettingsController exposure`'s own reasoning for
 * asserting the same two properties by reflection rather than by review.
 */
describe("AffiliateApplicationController exposure", () => {
  it("marks its one route @Public", () => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      AffiliateApplicationController.prototype.apply,
      AffiliateApplicationController,
    ]);

    expect(isPublic).toBe(true);
  });

  it("exposes its one route as a POST", () => {
    const method: unknown = Reflect.getMetadata(
      METHOD_METADATA,
      AffiliateApplicationController.prototype.apply,
    );

    expect(method).toBe(RequestMethod.POST);
  });
});
