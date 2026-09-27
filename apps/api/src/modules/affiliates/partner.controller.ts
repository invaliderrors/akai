import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Roles } from "../auth/guards/roles.guard";
import { CurrentUser, type Principal } from "../auth/security/principal";
import { AffiliateAdminService } from "./affiliate-admin.service";
import type { PartnerStats } from "./dto/affiliate-admin.dto";

/**
 * The partner's OWN restricted view: their discount code(s) and how many
 * times they've been used. Nothing else — no revenue, no other partner's
 * data, no admin surface.
 *
 * `@Roles("PARTNER")` at class level, matching every other admin/role-scoped
 * controller in this module. The affiliate row is resolved from
 * `principal.customerId`, never from a client-supplied id — see
 * `AffiliateAdminService.statsForPartnerByCustomerId`'s own doc comment for
 * why that is the whole IDOR defence here.
 */
@ApiTags("partner")
@Controller("partner")
@Roles("PARTNER")
export class PartnerController {
  constructor(private readonly affiliates: AffiliateAdminService) {}

  @Get("me")
  async me(@CurrentUser() principal: Principal): Promise<PartnerStats> {
    return this.affiliates.statsForPartnerByCustomerId(principal.customerId);
  }
}
