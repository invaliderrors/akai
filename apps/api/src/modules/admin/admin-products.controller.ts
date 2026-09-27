import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminRoles, CurrentAdmin, RequireFreshTwoFactor } from "./admin.decorators";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  bulkImportReportSchema,
  bulkImportRequestSchema,
  type BulkImportRequest,
} from "./admin.dto";
import { AdminProductsService, type BulkImportReport } from "./admin-products.service";
import { IdempotencyService } from "../idempotency/idempotency.service";
import type { AdminActor, ExportedProductRow } from "./admin.types";

const IMPORT_ROUTE = "POST /admin/products/bulk/import";

/**
 * Bulk catalogue operations.
 *
 * ADMIN only, and both routes require a fresh 2FA assertion: between them they
 * can read out the entire catalogue and rewrite it. That is the highest-value
 * pair of operations in the system, so they get the strongest control available
 * rather than the same treatment as a dashboard tile.
 *
 * There is deliberately NO single-product create/update/delete here. That is
 * CatalogModule's surface; duplicating it behind an /admin prefix would produce
 * two code paths to the same table with two sets of invariants.
 *
 * THE BASE PATH IS `admin/products/bulk`, NOT `admin/products`.
 *
 * Both this controller and CatalogModule's AdminProductsController were written
 * against `admin/products`. Express matches a path parameter against any single
 * segment, and AppModule imports CatalogModule before AdminModule, so catalog's
 * `GET admin/products/:id` was registered first and swallowed
 * `GET admin/products/export` — `:id` bound to the literal string "export",
 * which then failed uuid validation and returned 400. The export endpoint was
 * unreachable, and nothing in either module's tests could see it because each
 * suite mounts only its own controller.
 *
 * The extra segment removes the ambiguity structurally rather than by relying
 * on import order, which is the kind of coupling that breaks the next time
 * someone reorders the imports array for readability. `bulk/export` cannot
 * collide with catalog's routes: no catalog route is `:id/export`.
 */
@Controller("admin/products/bulk")
@UseGuards(AdminGuard)
@AdminRoles("ADMIN")
export class AdminProductsController {
  constructor(
    private readonly products: AdminProductsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get("export")
  @RequireFreshTwoFactor()
  export(@CurrentAdmin() actor: AdminActor): Promise<readonly ExportedProductRow[]> {
    return this.products.exportProducts(actor);
  }

  /**
   * Bulk import.
   *
   * The Idempotency-Key header is REQUIRED, not optional. A bulk import is long
   * enough to outlive a proxy timeout, which makes a client retry likely rather
   * than exceptional — and a retried import without a key silently duplicates
   * the work. Making the header optional means the dangerous path is the default
   * one, so it is rejected outright when absent.
   */
  @Post("import")
  @RequireFreshTwoFactor()
  async import(
    @CurrentAdmin() actor: AdminActor,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(bulkImportRequestSchema)) body: BulkImportRequest,
  ): Promise<BulkImportReport> {
    const key = idempotencyKey?.trim();
    if (key === undefined || key.length === 0) {
      throw new BadRequestException("Idempotency-Key header is required for bulk import");
    }

    const result = await this.idempotency.execute<BulkImportReport>({
      key,
      // Scoped to the ACTOR, not global: two admins may legitimately use the
      // same key value, and one must never receive the other's import report.
      userId: actor.customerId,
      route: IMPORT_ROUTE,
      request: body,
      responseSchema: bulkImportReportSchema,
      handler: () => this.products.importProducts(actor, body),
    });

    return result.value;
  }
}
