import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { idSchema, type Paginated } from "@akai/contracts";

import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/guards/roles.guard";
import { AffiliateAdminService } from "./affiliate-admin.service";
import {
  createAffiliateSchema,
  listAffiliatesQuerySchema,
  updateAffiliateSchema,
  type AdminAffiliate,
  type CreateAffiliateDto,
  type ListAffiliatesQuery,
  type PartnerLoginStatus,
  type UpdateAffiliateDto,
} from "./dto/affiliate-admin.dto";

/**
 * The admin affiliates screen — §14 of
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`:
 * "ver mis afiliados, asignarles un cupon y ver cuantas veces y cuantas
 * ventas, facturacion llevan cada uno."
 *
 * COUPON ASSIGNMENT IS NOT A ROUTE HERE. It happens through the EXISTING
 * `PATCH /admin/discounts/:id`, widened to accept `affiliateId` — the coupon
 * is the thing being edited, and reusing that endpoint means the whole
 * validated write path (existence checks, `.strict()` parsing, the same
 * error vocabulary) is inherited rather than reimplemented a second time for
 * one extra field. See `discount-admin.dto.ts`'s `updateDiscountSchema`.
 *
 * `@Roles` DECLARED AT CLASS LEVEL, matching `AdminDiscountsController` and
 * every other admin controller in this codebase — a new endpoint added here
 * inherits the restriction by default.
 */
@ApiTags("admin-affiliates")
@Controller("admin/affiliates")
@Roles("STAFF", "ADMIN")
export class AdminAffiliatesController {
  constructor(private readonly affiliates: AffiliateAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listAffiliatesQuerySchema)) query: ListAffiliatesQuery,
  ): Promise<Paginated<AdminAffiliate>> {
    return this.affiliates.list(query);
  }

  @Get(":id")
  async detail(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<AdminAffiliate> {
    return this.affiliates.get(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createAffiliateSchema)) body: CreateAffiliateDto,
  ): Promise<AdminAffiliate> {
    return this.affiliates.create(body);
  }

  @Patch(":id")
  async update(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateAffiliateSchema)) body: UpdateAffiliateDto,
  ): Promise<AdminAffiliate> {
    return this.affiliates.update(id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id", new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.affiliates.softDelete(id);
  }

  /**
   * Activate this affiliate's partner dashboard login, or resend the
   * password-setup email if one is already active — see
   * `AffiliateAdminService.activatePartnerLogin`'s own doc comment for why
   * this is one idempotent-in-effect endpoint rather than two.
   */
  @Post(":id/activate-login")
  async activateLogin(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<PartnerLoginStatus> {
    return this.affiliates.activatePartnerLogin(id);
  }
}
