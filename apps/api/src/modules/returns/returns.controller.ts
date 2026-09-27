import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  createReturnRequestSchema,
  idSchema,
  listReturnsQuerySchema,
  updateReturnRequestSchema,
  type CreateReturnRequest,
  type ListReturnsQuery,
  type Paginated,
  type ReturnRequest,
  type UpdateReturnRequest,
} from "@akai/contracts";

import { CurrentUser, type Principal } from "../auth/security/principal";
import { Roles } from "../auth/guards/roles.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ReturnsService } from "./returns.service";

/**
 * The CUSTOMER's own returns.
 *
 * Every handler is scoped to the caller's `customerId`, which is taken from the
 * verified principal and never from the request — ownership that comes off the
 * body is not ownership.
 */
@ApiTags("returns")
@Controller("returns")
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  @ApiOperation({ summary: "My return requests" })
  async list(
    @CurrentUser() actor: Principal,
    @Query(new ZodValidationPipe(listReturnsQuerySchema)) query: ListReturnsQuery,
  ): Promise<Paginated<ReturnRequest>> {
    return this.returns.listForCustomer(actor.customerId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Request a return for one of my delivered orders" })
  async create(
    @CurrentUser() actor: Principal,
    @Body(new ZodValidationPipe(createReturnRequestSchema)) body: CreateReturnRequest,
  ): Promise<ReturnRequest> {
    return this.returns.request(actor.customerId, body);
  }
}

/**
 * The OPERATOR's view.
 *
 * STAFF and ADMIN, declared at class level. Deciding a return is not a money
 * movement — refunding is a separate endpoint with its own idempotency — so it
 * does not need the ADMIN-only treatment a refund does.
 */
@ApiTags("admin-returns")
@Controller("admin/returns")
@Roles("STAFF", "ADMIN")
export class AdminReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  @ApiOperation({ summary: "All return requests" })
  async list(
    @Query(new ZodValidationPipe(listReturnsQuerySchema)) query: ListReturnsQuery,
  ): Promise<Paginated<ReturnRequest>> {
    return this.returns.listForAdmin(query);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Advance a return",
    description:
      "Validated against a closed transition map. Setting REFUNDED records that a refund happened; it does not issue one.",
  })
  async update(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateReturnRequestSchema)) body: UpdateReturnRequest,
  ): Promise<ReturnRequest> {
    return this.returns.update(id, body);
  }
}
