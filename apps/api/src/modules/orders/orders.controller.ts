import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Order, OrderSummary, Paginated } from "@akai/contracts";

import {
  type CustomerOrderListQuery,
  customerOrderListQuerySchema,
  orderNumberParamSchema,
} from "./dto/orders.dto";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrdersService } from "./orders.service";
import { CurrentUser, type Principal } from "../auth/security/principal";

/**
 * Customer-facing order history.
 *
 * THE SECURITY MODEL OF THIS CONTROLLER, in one sentence: no handler here takes
 * a customer id from the request. Every one of them passes `actor.customerId`
 * — which came from a verified session, not from the URL — into a service
 * method that resolves by (orderNumber AND customerId).
 *
 * That is deliberate and it is the whole defence. The natural-looking
 * alternative, `GET /customers/:customerId/orders`, puts the ownership key in
 * attacker-controlled space and then relies on someone remembering to compare it
 * against the session on every handler. That comparison is the thing people
 * forget, and forgetting it is the single most common vulnerability in customer
 * dashboards.
 *
 * These routes carry no `@Public()`, so the global deny-by-default JwtAuthGuard
 * covers them. `@CurrentUser` independently throws 401 when no verified principal
 * is present, so the routes stay closed even if the global guard is
 * misconfigured — two independent locks, because the cost is one decorator.
 */
@ApiTags("orders")
@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({
    summary: "The authenticated customer's order history, newest first",
    description:
      "Cursor-paginated. Scoped to the session's own customer id — there is no " +
      "parameter that could widen it to another customer.",
  })
  async list(
    @CurrentUser() actor: Principal,
    @Query(new ZodValidationPipe(customerOrderListQuerySchema))
    query: CustomerOrderListQuery,
  ): Promise<Paginated<OrderSummary>> {
    return this.orders.listForCustomer(actor.customerId, query);
  }

  @Get(":orderNumber")
  @ApiOperation({
    summary: "One of the authenticated customer's orders, by order number",
    description:
      "Returns 404 — not 403 — for an order belonging to someone else. A 403 " +
      "would confirm the order exists, and order numbers are sequential.",
  })
  async detail(
    @CurrentUser() actor: Principal,
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
  ): Promise<Order> {
    return this.orders.getForCustomer(actor.customerId, orderNumber);
  }

  @Get(":orderNumber/status")
  @ApiOperation({
    summary: "Poll an order's payment status",
    description:
      "Backs the post-checkout 'processing' screen. The browser returning from " +
      "the hosted payment page polls this rather than asserting success, because an order becomes " +
      "PAID only via a signature-verified webhook.",
  })
  async status(
    @CurrentUser() actor: Principal,
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
  ): Promise<{
    orderNumber: string;
    status: Order["status"];
    isPaid: boolean;
    isTerminal: boolean;
  }> {
    return this.orders.getStatusForCustomer(actor.customerId, orderNumber);
  }
}
