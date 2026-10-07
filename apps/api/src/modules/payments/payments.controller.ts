import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  confirmPaymentRequestSchema,
  type ConfirmPaymentRequest,
  type OrderStatusResponse,
} from "@akai/contracts";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/guards/roles.guard";
import { THROTTLE_RULES, Throttle } from "../throttler/throttle.decorator";
import { ThrottleGuard } from "../throttler/throttle.guard";
import {
  orderIdParamSchema,
  orderNumberParamSchema,
  type StartCheckoutResponse,
} from "./dto/payments.dto";
import { PaymentsService } from "./payments.service";

/**
 * The payments module's HTTP surface.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *  - A public "start a checkout for this order id" route — a direct IDOR.
 *    Ownership of a checkout is established by the CART, so CheckoutModule
 *    calls `PaymentsService.startCheckout()` in-process once it has verified
 *    the caller owns the cart. The only HTTP route for it here is the
 *    staff-only re-issue below.
 *  - A refund route. Wompi has no refund API for Web Checkout payments; staff
 *    refund in the Wompi dashboard and RECORD it at
 *    `POST /admin/orders/:orderNumber/refunds` (OrdersModule).
 */
@ApiTags("payments")
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Poll for payment settlement after returning from Wompi.
   *
   * `@Public()` because a guest checkout has no session; it returns only a
   * status — no PII, no totals, no line items. KNOWN TRADEOFF: order numbers
   * are sequential, so this is enumerable (existence + paid-ness).
   */
  @Public()
  @Get("payments/orders/:orderNumber/status")
  @ApiOperation({ summary: "Poll payment settlement for an order" })
  async status(
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
  ): Promise<OrderStatusResponse> {
    return this.payments.getOrderPaymentStatus(orderNumber);
  }

  /**
   * The return page hands back the transaction id Wompi appended to the
   * redirect (`?id=`). The API reads THAT transaction from Wompi with the
   * private key and settles from Wompi's answer — only if its reference belongs
   * to this order, through the same settlement as the webhook. Answers with the
   * same body as the status poll, and never fails because Wompi is slow.
   */
  @Public()
  @UseGuards(ThrottleGuard)
  @Throttle(THROTTLE_RULES.paymentConfirm)
  @Post("payments/orders/:orderNumber/confirm")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirm a returning Wompi transaction for an order" })
  async confirm(
    @Param("orderNumber", new ZodValidationPipe(orderNumberParamSchema))
    orderNumber: string,
    @Body(new ZodValidationPipe(confirmPaymentRequestSchema)) body: ConfirmPaymentRequest,
  ): Promise<OrderStatusResponse> {
    return this.payments.confirmPayment(orderNumber, body.transactionId);
  }

  /**
   * Re-issue a checkout link for an unpaid order. Staff-only, for support
   * ("my payment link expired"). Each re-issue is a NEW attempt with a new
   * Wompi reference.
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
