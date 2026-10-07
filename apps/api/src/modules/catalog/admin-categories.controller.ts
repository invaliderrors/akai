import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import {
  idSchema,
  type Category,
  type CategoryListResponse,
} from "@akai/contracts";

import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Roles } from "../auth/guards/roles.guard";
import { CategoriesService } from "../categories/categories.service";
import { ProductsService } from "./products.service";
import {
  createCategorySchema,
  reorderCategoriesSchema,
  updateCategorySchema,
  type CreateCategory,
  type ReorderCategories,
  type UpdateCategory,
} from "./dto/catalog.dto";

/**
 * Category admin CRUD.
 *
 * LIVES IN THE CATALOG MODULE, NOT THE CATEGORIES MODULE — `CategoriesModule`'s
 * own doc comment reserves this: it owns reading the category list as
 * navigation, and says a CRUD surface "belongs on the admin controller
 * alongside the [product/category] assignment route it must stay consistent
 * with" — `PUT /admin/products/:id/categories` on `AdminProductsController`,
 * in this same directory. So the WRITE logic sits on `ProductsService` beside
 * that route, and this controller injects `CategoriesService` for exactly one
 * thing — the read — rather than re-deriving "which categories exist" a
 * second way.
 *
 * A SEPARATE CONTROLLER CLASS, not new methods bolted onto
 * `AdminProductsController`, because Nest has no way to give one method a
 * different path prefix than its class's `@Controller()` — and "categories"
 * are not a sub-resource of "products" the way media or add-ons are.
 *
 * `@Roles` DECLARED AT CLASS LEVEL, ONCE — same reasoning as
 * `AdminProductsController`'s own comment: a new endpoint inherits the
 * restriction by default, so forgetting the decorator cannot ship an
 * unauthenticated write path.
 */
@Controller("admin/categories")
@Roles("STAFF", "ADMIN")
export class AdminCategoriesController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
  ) {}

  /**
   * Every non-deleted category, admin-visible regardless of product count —
   * the same list `GET /v1/categories` serves publicly, just behind auth so
   * the admin screen does not depend on an unauthenticated route staying
   * reachable from wherever the dashboard runs.
   */
  @Get()
  async list(): Promise<CategoryListResponse> {
    return this.categories.list();
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategory,
  ): Promise<Category> {
    return this.products.createCategory(body);
  }

  @Patch(":id")
  async update(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategory,
  ): Promise<Category> {
    return this.products.updateCategory(id, body);
  }

  /**
   * The category list's manual display order — the WHOLE of it, not a patch,
   * same "selection order is the value" shape `PUT /admin/products/reorder`
   * uses for products. NOT `:id/...`: no single category owns this write.
   */
  @Put("reorder")
  async reorder(
    @Body(new ZodValidationPipe(reorderCategoriesSchema)) body: ReorderCategories,
  ): Promise<{ reordered: number }> {
    return this.products.reorderCategories(body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id", new ZodValidationPipe(idSchema)) id: string): Promise<void> {
    await this.products.removeCategory(id);
  }
}
