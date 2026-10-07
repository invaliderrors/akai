import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { CategoriesModule } from "../categories/categories.module";
import { ProductsService } from "./products.service";
import { ProductInventoryService } from "./product-inventory.service";
import { ProductsController } from "./products.controller";
import { AdminProductsController } from "./admin-products.controller";
import { AdminCategoriesController } from "./admin-categories.controller";
import { CATALOG_BASE_COUNTRY, TaxRateResolver } from "./tax-rate.resolver";

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
      // as STORE_BASE_COUNTRY. "CO": the store sells in Colombia only.
      provide: CATALOG_BASE_COUNTRY,
      useValue: "CO",
    },
  ],
  exports: [ProductsService, ProductInventoryService],
})
export class CatalogModule {}
