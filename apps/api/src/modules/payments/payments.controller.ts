import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { OrderStatus } from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import {
  orderIdParamSchema,
  orderNumberParamSchema,
  refundRequestSchema,
  type RefundRequest,
  type RefundResponse,
  type StartCheckoutResponse,
} from "./dto/payments.dto";
import { Roles } from "../auth/guards/roles.guard";
import { CurrentUser, type Principal } from "../auth/security/principal";
import { PaymentsService } from "./payments.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

/**
 * The payments module's HTTP surface.
 *
 * WHAT IS DELIBERATELY NOT HERE: a public "start a checkout for this order id"
 * route. Such an endpoint is a direct IDOR — order ids are the only input, so
 * anyone holding or guessing one could mint a hosted checkout page displaying
 * another customer's email and line items. Ownership of a checkout is
 * established by the CART, which CheckoutModule owns, so that module calls
 * `PaymentsService.startCheckout()` in-process once it has verified the caller
 * owns the cart. The service is the API; the only HTTP route for it here is the
 * staff-only re-issue below, for support ("my payment link expired").
 */
@ApiTags("payments")
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Poll for payment settlement after returning from the hosted checkout.
   *
   * `@Public()` because a guest checkout has no session, and it returns only a
   * status — no PII, no totals, no line items.
   *
   * KNOWN TRADEOFF: order numbers are sequential (AK-2026-000123), so this is
   * enumerable — a scraper could learn that an order exists and whether it was
   * paid. Acceptable for the information disclosed, but the fix is a signed,
   * short-lived polling token issued with the checkout session. Tracked in
   * followUps.
   */
  @Public()
  @Get("payments/orders/:orderNumber/status")
  @ApiOperation({ summary: "Poll payment settlement for an order" })
  async status(
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
  ): Promise<{
    orderNumber: string;
    status: OrderStatus;
    isPaid: boolean;
    isTerminal: boolean;
  }> {
    return this.payments.getOrderPaymentStatus(orderNumber);
  }

  /**
   * Refund all or part of an order.
   *
   * STAFF and ADMIN only. The caller may propose an amount, but the ceiling is
   * recomputed server-side from the order row — see PaymentsService.refundOrder.
   */
  @Roles("ADMIN", "STAFF")
  @Post("admin/payments/orders/:orderId/refunds")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Refund an order (staff only)" })
  async refund(
    @Param("orderId", new ZodValidationPipe(orderIdParamSchema)) orderId: string,
    @Body(new ZodValidationPipe(refundRequestSchema)) body: RefundRequest,
    @CurrentUser() actor: Principal,
  ): Promise<RefundResponse> {
    return this.payments.refundOrder(orderId, body, actor.customerId);
  }

  /**
   * Re-issue a Checkout session for an unpaid order. Staff-only, for support.
   */
  @Roles("ADMIN", "STAFF")
  @Post("admin/payments/orders/:orderId/checkout-sessions")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Re-issue a hosted checkout link for an unpaid order" })
  async reissueCheckout(
    @Param("orderId", new ZodValidationPipe(orderIdParamSchema)) orderId: string,
  ): Promise<StartCheckoutResponse> {
    return this.payments.startCheckout(orderId);
  }
}
