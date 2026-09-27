import {
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Throttle, THROTTLE_RULES } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import { AffiliateLinksService } from "./affiliate-links.service";
import { partnerLinkSlugParamSchema } from "./dto/affiliate-link-admin.dto";

/**
 * The public side of a vanity link: SAME THREE-LAYER SHAPE
 * `AffiliateApplicationController` uses (public, throttled, `.strict()`/zod
 * at the boundary) — see `THROTTLE_RULES.partnerLinkVisit`'s own comment for
 * why its bucket is sized differently from that controller's.
 *
 * 404 FOR BOTH "never existed" AND "soft-deleted", the same posture the admin
 * routes already take — a visitor probing slugs learns nothing either way.
 */
@ApiTags("partner-links")
@Controller("partner-links")
export class PartnerLinksController {
  constructor(private readonly links: AffiliateLinksService) {}

  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.partnerLinkVisit)
  @Post(":slug/visit")
  @HttpCode(HttpStatus.OK)
  async visit(
    @Param("slug", new ZodValidationPipe(partnerLinkSlugParamSchema)) slug: string,
  ): Promise<{ readonly discountCode: string | null }> {
    const result = await this.links.resolveVisit(slug);
    if (result === null) {
      throw new NotFoundException("Link not found");
    }
    return result;
  }
}
