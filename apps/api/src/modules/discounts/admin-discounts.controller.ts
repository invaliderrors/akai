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
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { idSchema, type Paginated } from "@akai/contracts";

import { Roles } from "../auth/guards/roles.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createDiscountSchema,
  listDiscountsQuerySchema,
  updateDiscountSchema,
  type AdminDiscount,
  type CreateDiscountDto,
  type ListDiscountsQuery,
  type UpdateDiscountDto,
} from "./discount-admin.dto";
import { DiscountAdminService } from "./discount-admin.service";

/**
 * The admin coupon surface (issue SEV4 — "admins have no discount CRUD").
 *
 * STAFF and ADMIN only, declared at CLASS level so a handler added later inherits
 * the restriction rather than shipping an unauthenticated write path if someone
 * forgets the decorator. The globally-registered JwtAuthGuard + RolesGuard enforce
 * it (spec §8); CUSTOMER is deliberately absent from the role list.
 */
@ApiTags("admin-discounts")
@Controller("admin/discounts")
@Roles("STAFF", "ADMIN")
export class AdminDiscountsController {
  constructor(private readonly discounts: DiscountAdminService) {}

  @Get()
  @ApiOperation({ summary: "List discount codes with usage stats" })
  async list(
    @Query(new ZodValidationPipe(listDiscountsQuerySchema)) query: ListDiscountsQuery,
  ): Promise<Paginated<AdminDiscount>> {
    return this.discounts.list(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "One discount code with its usage stats" })
  async detail(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<AdminDiscount> {
    return this.discounts.get(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a discount code" })
  async create(
    @Body(new ZodValidationPipe(createDiscountSchema)) body: CreateDiscountDto,
  ): Promise<AdminDiscount> {
    return this.discounts.create(body);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a discount code (its code is immutable)" })
  async update(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateDiscountSchema)) body: UpdateDiscountDto,
  ): Promise<AdminDiscount> {
    return this.discounts.update(id, body);
  }

  /**
   * Soft delete. 204, no body: the code is intentionally still there (archived and
   * referenced by past redemptions), so returning it would invite a client to keep
   * offering it.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Archive (soft-delete) a discount code" })
  async remove(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.discounts.softDelete(id);
  }
}
