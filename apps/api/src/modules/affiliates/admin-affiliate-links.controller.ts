import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { idSchema } from "@akai/contracts";

import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/guards/roles.guard";
import { AffiliateLinksService } from "./affiliate-links.service";
import {
  createAffiliateLinkSchema,
  listAffiliateLinksQuerySchema,
  type AdminAffiliateLink,
  type CreateAffiliateLinkDto,
  type ListAffiliateLinksQuery,
} from "./dto/affiliate-link-admin.dto";

/**
 * Admin CRUD for an affiliate's vanity links, nested under the affiliate they
 * belong to — matching `AdminAffiliatesController`'s own `@Roles` posture
 * (class-level, so a new method here can never be forgotten unguarded).
 */
@ApiTags("admin-affiliates")
@Controller("admin/affiliates/:affiliateId/links")
@Roles("STAFF", "ADMIN")
export class AdminAffiliateLinksController {
  constructor(private readonly links: AffiliateLinksService) {}

  @Get()
  async list(
    @Param("affiliateId", new ZodValidationPipe(idSchema)) affiliateId: string,
    @Query(new ZodValidationPipe(listAffiliateLinksQuerySchema)) query: ListAffiliateLinksQuery,
  ): Promise<readonly AdminAffiliateLink[]> {
    return this.links.list(affiliateId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param("affiliateId", new ZodValidationPipe(idSchema)) affiliateId: string,
    @Body(new ZodValidationPipe(createAffiliateLinkSchema)) body: CreateAffiliateLinkDto,
  ): Promise<AdminAffiliateLink> {
    return this.links.create(affiliateId, body);
  }

  @Delete(":linkId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("affiliateId", new ZodValidationPipe(idSchema)) affiliateId: string,
    @Param("linkId", new ZodValidationPipe(idSchema)) linkId: string,
  ): Promise<void> {
    await this.links.softDelete(affiliateId, linkId);
  }
}
