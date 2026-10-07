import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { ThrottlerModule } from "../throttler/throttler.module";
import { CategoriesController } from "./categories.controller";
import {
  CATEGORIES_REPOSITORY,
  PrismaCategoriesRepository,
} from "./categories.repository";
import { CategoriesService } from "./categories.service";

/**
 * CategoriesModule — collections, their names and their ordering.
 *
 * OWNS exactly one thing: READING the category list for navigation. That is a
 * narrow charter and it is deliberate, because this directory was an empty
 * `@Module({})` sitting next to a CatalogModule that already owned every
 * category WRITE (`PUT /v1/admin/products/:id/categories`) and every category
 * READ that happens through a product. Two plausible homes for one concern is
 * how a codebase grows a second, subtly different definition of "visible".
 *
 * The split that keeps that from happening:
 *  * CatalogModule owns a category AS SEEN FROM A PRODUCT — writes, assignment,
 *    and the nested shape on a product payload.
 *  * This module owns the category list AS NAVIGATION — the standalone entity,
 *    its own ordering, and the shopper-visible product count.
 *
 * Nothing here writes. The admin category CRUD surface (create, rename,
 * reorder, delete — `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md`
 * §6) landed exactly where this comment said it must: on `ProductsService`,
 * beside `PUT /admin/products/:id/categories`, in `apps/api/src/modules/catalog`.
 * `CatalogModule` imports this module for `CategoriesService` — the ADMIN
 * LIST reuses the same read this module already owned — but every write still
 * goes through `ProductsService`. `CategoriesService` stays reading-only.
 */
@Module({
  imports: [PrismaModule, ThrottlerModule],
  controllers: [CategoriesController],
  providers: [
    CategoriesService,
    { provide: CATEGORIES_REPOSITORY, useClass: PrismaCategoriesRepository },
  ],
  exports: [CategoriesService],
})
export class CategoriesModule {}
