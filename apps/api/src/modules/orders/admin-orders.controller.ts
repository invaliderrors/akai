import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AdminOrder, AdminOrderSummary, Paginated, Refund, Shipment } from "@akai/contracts";

import {
  type AdminOrderListQuery,
  type AdminTransitionOrder,
  type CreateRefundRequest,
  type CreateShipmentRequest,
  adminOrderListQuerySchema,
  adminTransitionOrderSchema,
  createRefundRequestSchema,
  createShipmentRequestSchema,
  idParamSchema,
  orderNumberParamSchema,
} from "./dto/orders.dto";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrdersService } from "./orders.service";
import { CurrentUser, type Principal } from "../auth/security/principal";
import { Roles } from "../auth/guards/roles.guard";

/**
 * Operator-facing order management.
 *
 * `@Roles` is applied at the CLASS level, not per method. That is the load-
 * bearing decision in this file: a per-method guard protects the methods
 * somebody remembered, and the route that gets added in six months during an
 * incident is exactly the one that will be forgotten. Class-level means a new
 * handler is protected by default and unprotecting one requires a deliberate,
 * reviewable edit.
 *
 * `apps/api/src/modules/orders/admin-orders.controller.test.ts` enumerates every
 * route on this controller by reflection and asserts a CUSTOMER token gets 403
 * on each — so a future route cannot be added without inheriting that test.
 *
 * Note what this controller CANNOT do: mark an order PAID, or mark it REFUNDED.
 * Both are rejected by the state machine (`assertAdminMayAssign`) because they
 * assert that money moved, and only a signature-verified provider event can
 * know that. An operator issues a refund REQUEST here; the money and the status
 * follow from the webhook.
 */
@ApiTags("admin/orders")
@Controller("admin/orders")
@Roles("STAFF", "ADMIN")
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({
    summary: "All orders, filterable by status, email, order number or shipping state",
  })
  async list(
    @Query(new ZodValidationPipe(adminOrderListQuerySchema)) query: AdminOrderListQuery,
  ): Promise<Paginated<AdminOrderSummary>> {
    return this.orders.listForAdmin(query);
  }

  @Get(":orderNumber")
  @ApiOperation({
    summary: "Full order detail, including internal timeline entries",
    description:
      "Unlike the customer view, this includes `isInternal` events — operator " +
      "notes that must never reach the customer-facing timeline.",
  })
  async detail(
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
  ): Promise<AdminOrder> {
    return this.orders.getForAdmin(orderNumber);
  }

  @Patch(":orderNumber/status")
  @ApiOperation({
    summary: "Move an order through the fulfilment lifecycle",
    description:
      "403 for PAID, REFUNDED, PARTIALLY_REFUNDED, FAILED and the pre-payment " +
      "states: those are set by system events, not by hand. 409 for a move the " +
      "state machine does not permit.",
  })
  async transition(
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
    @Body(new ZodValidationPipe(adminTransitionOrderSchema)) body: AdminTransitionOrder,
    @CurrentUser() actor: Principal,
  ): Promise<AdminOrder> {
    return this.orders.transitionByAdmin(orderNumber, body, actor);
  }

  @Post(":orderNumber/shipments")
  @ApiOperation({
    summary: "Record a parcel covering a subset of the order's lines",
    description:
      "Rejects shipping more units than remain unshipped, so two operators " +
      "working the same order cannot double-ship it.",
  })
  async createShipment(
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
    @Body(new ZodValidationPipe(createShipmentRequestSchema)) body: CreateShipmentRequest,
    @CurrentUser() actor: Principal,
  ): Promise<Shipment> {
    return this.orders.createShipment(orderNumber, body, actor);
  }

  @Post("shipments/:shipmentId/delivered")
  @ApiOperation({
    summary: "Mark a parcel delivered; completes the order when all parcels are",
  })
  async markDelivered(
    @Param("shipmentId", new ZodValidationPipe(idParamSchema)) shipmentId: string,
    @CurrentUser() actor: Principal,
  ): Promise<Shipment> {
    return this.orders.markShipmentDelivered(shipmentId, actor);
  }

  @Post(":orderNumber/refunds")
  @ApiOperation({
    summary: "Record a refund made in the Wompi dashboard",
    description:
      "Wompi has no refund API for Web Checkout payments: staff refund in the " +
      "Wompi dashboard, then record it here. Writes a SUCCEEDED refund, moves " +
      "refundedTotal and the order to PARTIALLY_REFUNDED / REFUNDED, and emails " +
      "the customer. Bounded by what was captured.",
  })
  async recordRefund(
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
    @Body(new ZodValidationPipe(createRefundRequestSchema)) body: CreateRefundRequest,
    @CurrentUser() actor: Principal,
  ): Promise<Refund> {
    return this.orders.recordRefund(orderNumber, body, actor);
  }
}
