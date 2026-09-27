import { Module } from "@nestjs/common";
import { CLOCK, systemClock } from "../auth/ports/clock.port";
import { AdminBatchesController } from "./admin-batches.controller";
import { BatchesService } from "./batches.service";

/**
 * BatchesModule — lot ids, purity, HPLC/LC-MS dates, and COA documents behind
 * expiring signed URLs.
 *
 * WHAT WAS MISSING, and it was invisible rather than broken: nothing in the
 * platform could ever create a `batch` row or upload a certificate of
 * analysis, so `product.mapper.ts` had `coaUrl: null` hardcoded — not because
 * signing was unimplemented, but because there was nothing to sign. Every
 * batch a variant carried had to have been written directly against the
 * database.
 *
 * SELF-CONTAINED, unlike `MediaModule`. See `BatchesService`'s own doc
 * comment for why that split does not apply here: there is no pre-existing
 * catalog route this module would otherwise duplicate.
 *
 * ADMIN DATA ONLY, NOW. The storefront used to show a variant's newest lot
 * (purity, lot code, its certificate); the client then fixed the purity claim
 * sitewide ("≥99% HPLC") and moved the shop's certificate to the PRODUCT
 * (`Product.coaObjectKey` + `showCoa`, uploaded through
 * `AdminProductsController`). Lots and their certificates stay here as the
 * operator's record, and nothing on the storefront reads them.
 *
 * `CatalogModule` does not import this module and does not need to: reading a
 * signed `coaUrl` back out on an admin catalog read is
 * `ProductsService`'s own `signCoaUrl`, built from the same `presignGetUrl`
 * this module's uploads use `presignPutUrl` from — one shared, pure signing
 * primitive, two independent callers, no cross-module dependency between them.
 */
@Module({
  controllers: [AdminBatchesController],
  providers: [BatchesService, { provide: CLOCK, useValue: systemClock }],
  exports: [BatchesService],
})
export class BatchesModule {}
