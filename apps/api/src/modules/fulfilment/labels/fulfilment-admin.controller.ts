import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  type BulkLabelRequest,
  type BulkLabelResult,
  type CancelLabelResult,
  PRINT_LABELS_COUNT_HEADER,
  PRINT_LABELS_SKIPPED_HEADER,
  type PrintLabelsRequest,
  bulkLabelRequestSchema,
  bulkLabelResultSchema,
  cancelLabelResultSchema,
  idSchema,
  printLabelsRequestSchema,
} from "@akai/contracts";

import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Roles } from "../../auth/guards/roles.guard";
import { CurrentUser, type Principal } from "../../auth/security/principal";
import { IdempotencyService } from "../../idempotency/idempotency.service";
import { FulfilmentAdminService } from "./fulfilment-admin.service";

/** The slice of Express's response this controller writes: headers only. */
interface HeaderWriter {
  setHeader(name: string, value: string): void;
}

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (key === undefined || key === "") {
    throw new BadRequestException("Idempotency-Key header is required");
  }
  return key;
}

/**
 * Staff label actions — Sendcloud spec §5.
 *
 * `@Roles("STAFF", "ADMIN")` at the CLASS level, as on `AdminOrdersController`
 * and for the same reason: a route added here later is protected by default.
 * The controller test enumerates every route by reflection and asserts a
 * CUSTOMER gets 403 on each.
 *
 * EVERY STATE-CHANGING POST REQUIRES an `Idempotency-Key` — a label is a
 * billed purchase and a cancel is a vendor call, and a proxy timeout followed
 * by the dashboard's retry must replay the first answer, not act twice. The
 * print POST is the exception: it changes nothing (it merges files we already
 * hold), and replaying a multi-megabyte PDF out of the idempotency table would
 * be storing binary in a JSON column for no protection at all.
 */
@ApiTags("admin/fulfilment")
@Controller("admin/fulfilment")
@Roles("STAFF", "ADMIN")
export class FulfilmentAdminController {
  constructor(
    private readonly fulfilment: FulfilmentAdminService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post("labels")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Generate labels for up to 100 orders (one is the single-order case)",
    description:
      "Enqueues one label job per eligible order and answers at once with the " +
      "accepted order numbers and the skipped orders with a reason. Requires Idempotency-Key.",
  })
  async generate(
    @Body(new ZodValidationPipe(bulkLabelRequestSchema)) body: BulkLabelRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() actor: Principal,
  ): Promise<BulkLabelResult> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.execute<BulkLabelResult>({
      key,
      userId: actor.customerId,
      route: "POST /admin/fulfilment/labels",
      request: body,
      responseSchema: bulkLabelResultSchema,
      handler: () => this.fulfilment.enqueueLabels(body.orderIds, actor.customerId),
    });
    return result.value;
  }

  @Post("labels/print")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "One merged PDF of the orders' stored labels, in request order (≤ 200)",
    description:
      `Orders without a label are listed in the ${PRINT_LABELS_SKIPPED_HEADER} header; ` +
      "409 LABEL_NOT_AVAILABLE when none has one.",
  })
  async print(
    @Body(new ZodValidationPipe(printLabelsRequestSchema)) body: PrintLabelsRequest,
    @Res({ passthrough: true }) response: HeaderWriter,
  ): Promise<StreamableFile> {
    const printed = await this.fulfilment.print(body.orderIds);
    response.setHeader(PRINT_LABELS_SKIPPED_HEADER, printed.skippedOrderIds.join(","));
    response.setHeader(PRINT_LABELS_COUNT_HEADER, String(printed.count));
    return new StreamableFile(printed.pdf, {
      type: "application/pdf",
      disposition: 'attachment; filename="etiquetas.pdf"',
      length: printed.pdf.byteLength,
    });
  }

  @Get("shipments/:shipmentId/label")
  @Header("Cache-Control", "no-store")
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiOperation({ summary: "302 to a short-lived signed URL for the shipment's label PDF" })
  async label(
    @Param("shipmentId", new ZodValidationPipe(idSchema)) shipmentId: string,
  ): Promise<{ url: string; statusCode: number }> {
    return { url: await this.fulfilment.labelUrl(shipmentId), statusCode: HttpStatus.FOUND };
  }

  @Post("shipments/:shipmentId/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Cancel a label the carrier has not scanned yet; the order returns to PAID",
    description: "409 CANCEL_REJECTED when the carrier no longer allows it. Requires Idempotency-Key.",
  })
  async cancel(
    @Param("shipmentId", new ZodValidationPipe(idSchema)) shipmentId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() actor: Principal,
  ): Promise<CancelLabelResult> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.execute<CancelLabelResult>({
      key,
      userId: actor.customerId,
      route: "POST /admin/fulfilment/shipments/:id/cancel",
      request: { shipmentId },
      responseSchema: cancelLabelResultSchema,
      handler: () => this.fulfilment.cancel(shipmentId, actor.customerId),
    });
    return result.value;
  }

  @Post("shipments/:shipmentId/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Re-enqueue a FAILED label as a fresh attempt",
    description: "Same accepted/skipped answer as the bulk endpoint. Requires Idempotency-Key.",
  })
  async retry(
    @Param("shipmentId", new ZodValidationPipe(idSchema)) shipmentId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() actor: Principal,
  ): Promise<BulkLabelResult> {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.idempotency.execute<BulkLabelResult>({
      key,
      userId: actor.customerId,
      route: "POST /admin/fulfilment/shipments/:id/retry",
      request: { shipmentId },
      responseSchema: bulkLabelResultSchema,
      handler: () => this.fulfilment.retry(shipmentId, actor.customerId),
    });
    return result.value;
  }
}
