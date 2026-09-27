import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { PartnerLinksController } from "./partner-links.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { THROTTLE_KEY, THROTTLE_RULES } from "../throttler/throttle.decorator";

/**
 * The public visit route's one route must stay reachable with no session —
 * a link only works if a stranger clicking it works — and must carry its own
 * rate-limit bucket, matching `AffiliateApplicationController exposure`'s
 * and `CheckoutController`'s own reasoning for asserting these by reflection.
 */
describe("PartnerLinksController exposure", () => {
  it("marks its one route @Public", () => {
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      PartnerLinksController.prototype.visit,
      PartnerLinksController,
    ]);

    expect(isPublic).toBe(true);
  });

  it("exposes its one route as a POST", () => {
    const method: unknown = Reflect.getMetadata(
      METHOD_METADATA,
      PartnerLinksController.prototype.visit,
    );

    expect(method).toBe(RequestMethod.POST);
  });

  it("carries the partner-link-visit throttle rule, its own bucket separate from every other public form", () => {
    const rule: unknown = Reflect.getMetadata(THROTTLE_KEY, PartnerLinksController.prototype.visit);

    expect(rule).toEqual(THROTTLE_RULES.partnerLinkVisit);
  });
});
