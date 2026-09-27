import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  affiliateApplicationSchema,
  type AffiliateApplication,
  type AffiliateApplicationResponse,
} from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { extractClientIp } from "../auth/guards/rate-limit.guard";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { AffiliateApplicationService } from "./affiliate-application.service";

/**
 * The affiliate sign-up form — §5 of
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`.
 *
 * SAME THREE-LAYER SHAPE `ContactController` uses, and for the identical
 * reason: an anonymous HTTP request that produces outbound email is the
 * classic spam-relay shape, whichever form asks for it.
 *  1. `ThrottleGuard` on its OWN bucket (`THROTTLE_RULES.affiliateApply`) —
 *     same rate as `contact`, a separate budget so one form's abuse cannot
 *     spend the other's.
 *  2. Turnstile verification inside `AffiliateApplicationService`, honouring
 *     an explicit rejection while failing open on a Cloudflare outage.
 *  3. A `.strict()` schema with closed field shapes, so the body cannot
 *     smuggle anything this form did not ask for.
 */
@ApiTags("affiliates")
@Controller("affiliates")
export class AffiliateApplicationController {
  constructor(private readonly applications: AffiliateApplicationService) {}

  /**
   * 202 ACCEPTED, not 200 — same honesty `ContactController.submit` states
   * for itself: accepted for review, not yet reviewed.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.affiliateApply)
  @Post("apply")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Submit an affiliate application" })
  async apply(
    @Body(new ZodValidationPipe(affiliateApplicationSchema)) body: AffiliateApplication,
    @Req() request: unknown,
  ): Promise<AffiliateApplicationResponse> {
    return this.applications.submit(body, extractClientIp(request));
  }
}
