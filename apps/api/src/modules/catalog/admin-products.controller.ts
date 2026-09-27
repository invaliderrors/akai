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
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createProductSchema,
  idSchema,
  offerEverywhereSchema,
  updateProductSchema,
  type CreateProduct,
  type CreateVariant,
  type InventoryItem,
  type OfferEverywhere,
  type OfferEverywhereResult,
  type Paginated,
  type Product,
  type ProductVariant,
  type UpdateProduct,
} from "@akai/contracts";
import { ProductsService, type ProductWriteResult } from "./products.service";
import { CONTENT_SANITIZED_HEADER } from "./catalog.constants";
import { ProductInventoryService } from "./product-inventory.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { Roles } from "../auth/guards/roles.guard";
import { CurrentUser, type Principal } from "../auth/security/principal";

import {
  addMediaSchema,
  addVariantSchema,
  adjustInventorySchema,
  adminProductListQuerySchema,
  reorderProductsSchema,
  setAddOnsSchema,
  setCategoriesSchema,
  setInventoryPolicySchema,
  setRestrictionsSchema,
  updateVariantSchema,
  type AddMedia,
  type AdjustInventory,
  type AdminProductListQuery,
  type ReorderProducts,
  type SetAddOns,
  type SetCategories,
  type SetInventoryPolicy,
  type SetRestrictions,
  type UpdateVariant,
} from "./dto/catalog.dto";
import {
  attachCoaSchema,
  createCoaUploadUrlSchema,
  type AttachCoa,
  type CoaUploadUrlResponse,
  type CreateCoaUploadUrl,
} from "../batches/batches.dto";

/**
 * The one thing this file needs from an HTTP response.
 *
 * NARROWER THAN `Response` ON PURPOSE. Express's `Response` is structurally
 * assignable to this, so the controller passes its real one unchanged — but a
 * test can supply a recording double that is fully typed, with no cast through
 * `unknown` and no partial-mock fiction. The alternative is a helper that can
 * only be exercised by standing up an HTTP server to observe one header.
 */
export interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/**
 * Announce that the stored copy differs from the submitted copy.
 *
 * The description sanitiser rewrites an operator's input, and a rewrite the API
 * does not mention is indistinguishable from an editor losing text. The body
 * stays exactly the `Product` resource — every admin client parses it against
 * the `.strict()` contract schema, so a warning field there would break them
 * all — and the notice rides beside it in a header whose value is a closed set
 * of `Locale` codes, never prose. `CONTENT_SANITIZED_HEADER` carries the full
 * argument, including why this is not a 400.
 *
 * The header is set ONLY when something actually changed: its absence is the
 * "nothing was altered" case, so there is no falsy value for a client to
 * misread as a warning.
 */
export function reportSanitizedContent(
  result: ProductWriteResult,
  response: HeaderSink,
): Product {
  if (result.sanitizedLocales.length > 0) {
    response.setHeader(CONTENT_SANITIZED_HEADER, result.sanitizedLocales.join(","));
  }
  return result.product;
}

/**
 * Every catalog write in the system.
 *
 * THE GUARD AND THE ROLES ARE DECLARED AT CLASS LEVEL, ONCE. Per-method
 * annotation is the common pattern and it is the wrong one here: adding a new
 * endpoint to this controller and forgetting the decorator would ship an
 * unauthenticated write path, and nothing about the resulting code looks wrong.
 * Declared on the class, a new method inherits the restriction by default and
 * the failure mode of forgetting something is a 403 in development.
 *
 * `admin-products.controller.test.ts` reflects over every handler and asserts
 * CUSTOMER can reach none of them — including handlers added after this comment
 * was written, which is the point.
 *
 * CUSTOMER is deliberately absent from the role list. STAFF and ADMIN differ
 * elsewhere (spec §8 requires a fresh 2FA assertion for admin surfaces); this
 * module does not encode that distinction and defers it to the auth layer.
 */
@Controller("admin/products")

@Roles("STAFF", "ADMIN")
export class AdminProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly inventory: ProductInventoryService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  @Get()
  async list(
    @Query(new ZodValidationPipe(adminProductListQuerySchema))
    query: AdminProductListQuery,
  ): Promise<Paginated<Product>> {
    return this.products.listAdmin(query, query.locale);
  }

  @Get(":id")
  async detail(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<Product> {
    return this.products.getByIdAdmin(id);
  }

  // -------------------------------------------------------------------------
  // Product lifecycle
  // -------------------------------------------------------------------------

  /**
   * `@Res({ passthrough: true })` — Nest still serialises the returned value;
   * without `passthrough` it would hand the response over entirely and the body
   * would never be written.
   */
  @Post()
  async create(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProduct,
    @CurrentUser() user: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Product> {
    return reportSanitizedContent(
      await this.products.create(body, user.customerId),
      response,
    );
  }

  @Patch(":id")
  async update(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProduct,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Product> {
    return reportSanitizedContent(await this.products.update(id, body), response);
  }

  @Post(":id/publish")
  async publish(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<Product> {
    return this.products.setPublished(id, true);
  }

  @Post(":id/unpublish")
  async unpublish(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<Product> {
    return this.products.setPublished(id, false);
  }

  /**
   * Soft delete. 204 with no body: the resource is intentionally still there
   * (archived), so returning it would invite a client to keep rendering it.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.products.softDelete(id);
  }

  @Post(":id/restore")
  async restore(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<Product> {
    return this.products.restore(id);
  }

  // -------------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------------

  @Post(":id/variants")
  async addVariant(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(addVariantSchema)) body: CreateVariant,
    @CurrentUser() user: Principal,
  ): Promise<ProductVariant> {
    return this.products.addVariant(id, body, user.customerId);
  }

  @Patch("variants/:variantId")
  async updateVariant(
    @Param("variantId", new ZodValidationPipe(idSchema)) variantId: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariant,
    @CurrentUser() user: Principal,
  ): Promise<ProductVariant> {
    return this.products.updateVariant(variantId, body, user.customerId);
  }

  @Delete("variants/:variantId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteVariant(
    @Param("variantId", new ZodValidationPipe(idSchema)) variantId: string,
  ): Promise<void> {
    await this.products.deleteVariant(variantId);
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  @Get("variants/:variantId/inventory")
  async getInventory(
    @Param("variantId", new ZodValidationPipe(idSchema)) variantId: string,
  ): Promise<InventoryItem> {
    return this.inventory.get(variantId);
  }

  @Post("variants/:variantId/inventory/adjust")
  async adjustInventory(
    @Param("variantId", new ZodValidationPipe(idSchema)) variantId: string,
    @Body(new ZodValidationPipe(adjustInventorySchema))
    body: AdjustInventory,
    @CurrentUser() user: Principal,
  ): Promise<InventoryItem> {
    return this.inventory.adjust(variantId, body, user.customerId);
  }

  @Put("variants/:variantId/inventory/policy")
  async setInventoryPolicy(
    @Param("variantId", new ZodValidationPipe(idSchema)) variantId: string,
    @Body(new ZodValidationPipe(setInventoryPolicySchema))
    body: SetInventoryPolicy,
  ): Promise<InventoryItem> {
    return this.inventory.setPolicy(variantId, body);
  }

  // -------------------------------------------------------------------------
  // Media, categories, restrictions
  // -------------------------------------------------------------------------

  @Post(":id/media")
  async addMedia(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(addMediaSchema)) body: AddMedia,
  ): Promise<Product> {
    return this.products.addMedia(id, body);
  }

  @Delete(":id/media/:mediaId")
  async removeMedia(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Param("mediaId", new ZodValidationPipe(idSchema)) mediaId: string,
  ): Promise<Product> {
    return this.products.removeMedia(id, mediaId);
  }

  // -------------------------------------------------------------------------
  // The product's certificate of analysis
  // -------------------------------------------------------------------------
  //
  // The same presign → PUT → confirm lifecycle, and the SAME request schemas
  // (`application/pdf` only, ≤ 10 MB, the server chooses the key), as a lot's
  // certificate on `AdminBatchesController` — keyed per product instead. Class-
  // level `@Roles` covers all three. Whether the shop shows the file is the
  // separate `showCoa` field, saved with the product through `PATCH :id`.

  /** 200, not 201: a capability is issued, nothing is created yet. */
  @Post(":id/coa/upload-url")
  @HttpCode(HttpStatus.OK)
  async createCoaUploadUrl(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(createCoaUploadUrlSchema)) body: CreateCoaUploadUrl,
  ): Promise<CoaUploadUrlResponse> {
    return this.products.createCoaUploadUrl(id, body);
  }

  /** Record a succeeded upload — a first upload and a replacement alike. */
  @Post(":id/coa")
  @HttpCode(HttpStatus.OK)
  async attachCoa(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(attachCoaSchema)) body: AttachCoa,
  ): Promise<Product> {
    return this.products.attachCoa(id, body);
  }

  @Delete(":id/coa")
  async removeCoa(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<Product> {
    return this.products.removeCoa(id);
  }

  @Put(":id/categories")
  async setCategories(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(setCategoriesSchema)) body: SetCategories,
  ): Promise<Product> {
    return this.products.setCategories(id, body);
  }

  @Put(":id/add-ons")
  async setAddOns(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(setAddOnsSchema)) body: SetAddOns,
  ): Promise<Product> {
    return this.products.setAddOns(id, body);
  }

  /**
   * The catalogue-wide manual display order — full replacement, same
   * "ordering is part of the value" reasoning as `:id/categories` and
   * `:id/add-ons` above, just scoped to the whole catalogue rather than one
   * product's edges. NOT `:id/...`: no single product owns this write.
   *
   * Returns a count, not a product list, for the same reason
   * `offerEverywhere` does: there is no single resource this acted on.
   */
  @Put("reorder")
  async reorder(
    @Body(new ZodValidationPipe(reorderProductsSchema)) body: ReorderProducts,
  ): Promise<{ reordered: number }> {
    return this.products.reorder(body);
  }

  /**
   * Offer ONE add-on on every product page, in a single write.
   *
   * POST, NOT PUT, AND ON THE ADD-ON'S OWN ID. `PUT :id/add-ons` above is
   * idempotent replacement of one host's list; this runs the other way — it
   * takes the add-on and appends it to every host — so it is neither the same
   * resource nor a replacement. Doing it as N calls to the route above would be
   * a read-modify-write per host, which races with any concurrent edit and can
   * silently drop add-ons a colleague added between the read and the write.
   *
   * It returns COUNTS rather than a Product: there is no single product this
   * acted on, and "attached 14, 2 already had it, 1 at the cap" is the only
   * honest answer.
   */
  @Post(":id/offer-everywhere")
  async offerEverywhere(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(offerEverywhereSchema)) body: OfferEverywhere,
  ): Promise<OfferEverywhereResult> {
    return this.products.offerEverywhere(id, body);
  }

  @Put(":id/restrictions")
  async setRestrictions(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(setRestrictionsSchema))
    body: SetRestrictions,
  ): Promise<Product> {
    return this.products.setRestrictions(id, body);
  }
}
