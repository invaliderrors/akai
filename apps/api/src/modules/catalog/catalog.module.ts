import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import type { ServerEnv } from "@akai/config";
import { CLOCK, type Clock, systemClock } from "../auth/ports/clock.port";
import { SERVER_CONFIG } from "../config/config.module";
import { CategoriesModule } from "../categories/categories.module";
import { ProductsService } from "./products.service";
import { ProductInventoryService } from "./product-inventory.service";
import { ProductsController } from "./products.controller";
import { AdminProductsController } from "./admin-products.controller";
import { AdminCategoriesController } from "./admin-categories.controller";
import { CATALOG_BASE_COUNTRY, TaxRateResolver } from "./tax-rate.resolver";
import { COA_FILE_READER, type CoaFileReader, S3CoaFileReader } from "./coa-file.reader";

/** The fixed region every presigner call site uses (see `LabelsModule`). */
const S3_REGION = "us-east-1";

/**
 * CatalogModule — products, variants, media, categories, inventory.
 *
 * OWNS: the sellable catalog. The VARIANT is the sellable unit; a
 * single-variant product still gets exactly one variant row.
 *
 * DOES NOT OWN, AND DELIBERATELY DOES NOT TOUCH:
 *  - The payment gateway. There is no `@whop/sdk` import in this directory, and
 *    there is nothing for one to do: Whop accepts our computed amount on the
 *    checkout call, so publishing a product and being able to sell it are not
 *    coupled at all. The previous provider could only reference a mirrored
 *    variant, which made every catalog write a sync obligation; that mirror and
 *    its outbox topics are deleted. A mutation still enqueues a storefront cache
 *    purge, which is a cache concern rather than a payments one.
 *  - Tax RATES. `TaxRateResolver` reads the `tax_rate` table directly as an
 *    interim measure; TaxModule should provide it. See followUps.
 *  - Auth. The controllers carry `@Roles` from AuthModule and rely on the
 *    globally registered JwtAuthGuard + RolesGuard (spec §8). The local
 *    stand-ins that existed while AuthModule was a placeholder are deleted.
 *
 * `ProductsService` and `ProductInventoryService` are EXPORTED because cart,
 * checkout and orders all need to read variants and hold stock. They will
 * import this module rather than reach into Prisma for catalog tables — which
 * is what keeps price derivation and the oversell guard in one place instead of
 * reimplemented per caller.
 *
 * `CategoriesModule` IS IMPORTED, for exactly one export —
 * `AdminCategoriesController` reads the category list through
 * `CategoriesService` rather than re-deriving "which categories are visible" a
 * second way. Category CRUD WRITES still live here (`ProductsService`), per
 * `CategoriesModule`'s own doc comment; see `admin-categories.controller.ts`.
 */
@Module({
  // ThrottlerModule imported EXPLICITLY, not relied upon as global: the
  // public catalog routes carry @UseGuards(ThrottleGuard), and a guard whose
  // provider is only present when some other module happened to pull it in
  // is a rate limit that silently disappears under a different composition.
  imports: [PrismaModule, ThrottlerModule, CategoriesModule],
  controllers: [ProductsController, AdminProductsController, AdminCategoriesController],
  providers: [
    ProductsService,
    ProductInventoryService,
    TaxRateResolver,
    {
      // Interim home for the store's base country; belongs in validated config
      // as STORE_BASE_COUNTRY. "ES" matches the storefront's default locale.
      provide: CATALOG_BASE_COUNTRY,
      useValue: "ES",
    },
    // `ProductsService` signs COA read URLs, and a presigned URL's signature is
    // a function of the signing time — same reasoning MediaModule's upload
    // signer is injected for, so a test can fix the clock and assert on it.
    { provide: CLOCK, useValue: systemClock },
    {
      // The server-side read behind `GET /v1/products/:slug/coa/file` — the
      // in-page certificate viewer. Same private bucket, same presigner, as
      // `S3LabelStorage`.
      provide: COA_FILE_READER,
      inject: [SERVER_CONFIG, CLOCK],
      useFactory: (config: ServerEnv, clock: Clock): CoaFileReader =>
        new S3CoaFileReader(
          {
            endpoint: config.S3_ENDPOINT,
            bucket: config.S3_BUCKET_COA,
            region: S3_REGION,
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
          clock,
        ),
    },
  ],
  exports: [ProductsService, ProductInventoryService],
})
export class CatalogModule {}
