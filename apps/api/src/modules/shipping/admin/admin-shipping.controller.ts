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
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  createShippingRateSchema,
  createShippingZoneSchema,
  idSchema,
  updateShippingRateSchema,
  updateShippingZoneSchema,
  type AdminShippingRate,
  type AdminShippingRateList,
  type AdminShippingZoneDetail,
  type AdminShippingZoneList,
  type CreateShippingRate,
  type CreateShippingZone,
  type UpdateShippingRate,
  type UpdateShippingZone,
} from "@akai/contracts";

import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Roles } from "../../auth/guards/roles.guard";
import { AdminShippingService } from "./admin-shipping.service";

/**
 * Staff-editable shipping zones and rates (spec §7a, decision D8).
 *
 * STAFF AND ADMIN, READ AND WRITE — the categories/discounts precedent
 * (`AdminCategoriesController`, `AdminDiscountsController`): the operators who
 * run the catalogue and the coupons run delivery too. Declared at CLASS level
 * so a handler added later inherits it instead of shipping an endpoint any
 * signed-in customer could reach (the API is deny-by-default, but "any
 * authenticated principal" is what a missing `@Roles` means).
 *
 * Rates are a sub-resource of their zone in the URL, and the service checks
 * the pairing: a rate id under the wrong zone is a 404, never an edit of a rate
 * in another zone.
 */
@ApiTags("admin-shipping")
@Controller("admin/shipping")
@Roles("STAFF", "ADMIN")
export class AdminShippingController {
  constructor(private readonly shipping: AdminShippingService) {}

  @Get("zones")
  @ApiOperation({ summary: "Every live shipping zone with its live rates" })
  async listZones(): Promise<AdminShippingZoneList> {
    return this.shipping.listZones();
  }

  @Post("zones")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a shipping zone" })
  async createZone(
    @Body(new ZodValidationPipe(createShippingZoneSchema)) body: CreateShippingZone,
  ): Promise<AdminShippingZoneDetail> {
    return this.shipping.createZone(body);
  }

  @Patch("zones/:zoneId")
  @ApiOperation({ summary: "Rename a zone, change its countries or its sort order" })
  async updateZone(
    @Param("zoneId", new ZodValidationPipe(idSchema)) zoneId: string,
    @Body(new ZodValidationPipe(updateShippingZoneSchema)) body: UpdateShippingZone,
  ): Promise<AdminShippingZoneDetail> {
    return this.shipping.updateZone(zoneId, body);
  }

  /** Soft delete, with its rates. 204: nothing is left to return. */
  @Delete("zones/:zoneId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Soft-delete a shipping zone and its rates" })
  async deleteZone(
    @Param("zoneId", new ZodValidationPipe(idSchema)) zoneId: string,
  ): Promise<void> {
    await this.shipping.deleteZone(zoneId);
  }

  @Get("zones/:zoneId/rates")
  @ApiOperation({ summary: "A zone's live rates (active and inactive)" })
  async listRates(
    @Param("zoneId", new ZodValidationPipe(idSchema)) zoneId: string,
  ): Promise<AdminShippingRateList> {
    return this.shipping.listRates(zoneId);
  }

  @Post("zones/:zoneId/rates")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a rate in a zone" })
  async createRate(
    @Param("zoneId", new ZodValidationPipe(idSchema)) zoneId: string,
    @Body(new ZodValidationPipe(createShippingRateSchema)) body: CreateShippingRate,
  ): Promise<AdminShippingRate> {
    return this.shipping.createRate(zoneId, body);
  }

  /** Also how a rate is deactivated: `{ "isActive": false }`. */
  @Patch("zones/:zoneId/rates/:rateId")
  @ApiOperation({ summary: "Update (or deactivate) a rate" })
  async updateRate(
    @Param("zoneId", new ZodValidationPipe(idSchema)) zoneId: string,
    @Param("rateId", new ZodValidationPipe(idSchema)) rateId: string,
    @Body(new ZodValidationPipe(updateShippingRateSchema)) body: UpdateShippingRate,
  ): Promise<AdminShippingRate> {
    return this.shipping.updateRate(zoneId, rateId, body);
  }

  @Delete("zones/:zoneId/rates/:rateId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Soft-delete a rate (orders keep their snapshot)" })
  async deleteRate(
    @Param("zoneId", new ZodValidationPipe(idSchema)) zoneId: string,
    @Param("rateId", new ZodValidationPipe(idSchema)) rateId: string,
  ): Promise<void> {
    await this.shipping.deleteRate(zoneId, rateId);
  }
}
