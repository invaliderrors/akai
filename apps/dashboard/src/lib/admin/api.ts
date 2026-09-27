import { z } from "zod";
import {
  type AdminBlogPost,
  type AdminBlogPostListResponse,
  type BlogCoverUploadUrlRequest,
  type BlogPostStatus,
  type CreateBlogPost,
  type ImageUploadUrlResponse,
  type UpdateBlogPost,
  adminBlogPostListResponseSchema,
  adminBlogPostSchema,
  imageUploadUrlResponseSchema,
  type Category,
  type CategoryListResponse,
  type CreateProduct,
  type EmailEvent,
  type EmailStatus,
  type InventoryFilter,
  type JobState,
  type JobsSummary,
  type Locale,
  type OfferEverywhere,
  type OfferEverywhereResult,
  type ProductKind,
  type Role,
  type SiteSettings,
  type TranslateRequest,
  type TranslateResponse,
  type UpdateProduct,
  type UpdateSiteSettings,
  adminCustomerSchema,
  adminOrderSchema,
  categoryListResponseSchema,
  categorySchema,
  emailEventSchema,
  inventoryItemSchema,
  jobSchema,
  jobsSummarySchema,
  offerEverywhereResultSchema,
  paginatedInventorySchema,
  paginatedSchema,
  productSchema,
  productVariantSchema,
  refundSchema,
  siteSettingsSchema,
  translateResponseSchema,
} from "@akai/contracts";
import { parseSanitizedLocales } from "./catalog-headers";
import { parseOrThrow, type AdminHttp } from "./http";
import {
  adminAffiliateLinkSchema,
  adminAffiliateSchema,
  adminDiscountSchema,
  paginatedAffiliatesSchema,
  paginatedCustomersSchema,
  paginatedDiscountsSchema,
  paginatedOrdersSchema,
  paginatedProductsSchema,
  partnerLoginStatusSchema,
  dailyRevenuePointSchema,
  emailDeliverySummarySchema,
  lowStockVariantSchema,
  metricsOverviewSchema,
  recentOrderSchema,
  repeatCustomerRateSchema,
  returnsSummarySchema,
  topProductSchema,
  type AddVariantRequest,
  type AdjustInventoryRequest,
  type AdminAffiliateLink,
  type CreateAffiliateLinkRequest,
  type CreateAffiliateRequest,
  type CreateDiscountRequest,
  type CreateRefundRequest,
  type PartnerLoginStatus,
  type SetInventoryPolicyRequest,
  type TransitionOrderRequest,
  type UpdateAffiliateRequest,
  type UpdateDiscountRequest,
  type UpdateVariantRequest,
} from "./schemas";

/**
 * The typed admin API surface.
 *
 * Every function here takes an `AdminHttp` rather than reaching for a module
 * singleton. That is what makes the whole layer testable with a hand-written
 * fake and no `vi.stubGlobal('fetch', …)`, and it is what lets the auth-shell
 * slice's real client drop in without touching a single call site.
 *
 * Every RESPONSE goes through `parseOrThrow`. There is no `as` in this file.
 */

export interface AdminProductListParams {
  readonly status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  readonly search?: string;
  readonly category?: string;
  readonly sort?: "newest" | "price_asc" | "price_desc" | "name" | "manual";
  readonly includeDeleted?: boolean;
  readonly locale?: "es" | "en";
  readonly cursor?: string;
  readonly limit?: number;
  /** `PACK` powers the dedicated `/admin/products/packs` list. */
  readonly kind?: ProductKind;
}

/**
 * Offer ONE add-on on every product page, in a single server-side write.
 *
 * POST on the ADD-ON's id, not on a host's. `PUT :id/add-ons` replaces one
 * host's list; this runs the other way and appends to all of them. Looping the
 * replace route from here would be a read-modify-write per host over the
 * network, which races with anyone else editing one of those products.
 *
 * Returns counts, not a product: there is no single product this acted on.
 */
export async function offerEverywhere(
  http: AdminHttp,
  id: string,
  input: OfferEverywhere,
): Promise<OfferEverywhereResult> {
  const response = await http.request({
    method: "POST",
    path: `/admin/products/${encodeURIComponent(id)}/offer-everywhere`,
    body: input,
  });

  return parseOrThrow(offerEverywhereResultSchema, response);
}

/**
 * The catalogue's manual display order — full replacement. `productIds` is
 * the WHOLE new order, not a patch: the API assigns each one's `sortOrder`
 * from its position in the array, the same "selection order is the value"
 * shape `offerEverywhere`'s sibling routes already use.
 *
 * Returns a count, not a product list: there is no single product this
 * write is "about".
 */
const reorderResultSchema = z.object({ reordered: z.number().int().min(0) }).strict();

export async function reorderProducts(
  http: AdminHttp,
  productIds: readonly string[],
): Promise<z.infer<typeof reorderResultSchema>> {
  const response = await http.request({
    method: "PUT",
    path: "/admin/products/reorder",
    body: { productIds },
  });

  return parseOrThrow(reorderResultSchema, response);
}

/**
 * Every non-deleted category, admin-visible regardless of product count.
 *
 * Not paginated — a store's category tree is tens of rows, matching the
 * public `GET /v1/categories` this admin route mirrors behind auth.
 */
export async function listCategories(http: AdminHttp): Promise<CategoryListResponse> {
  const response = await http.request({ method: "GET", path: "/admin/categories" });
  return parseOrThrow(categoryListResponseSchema, response);
}

export interface CreateCategoryInput {
  readonly slug: string;
  readonly name: { readonly es: string; readonly en: string };
}

export async function createCategory(
  http: AdminHttp,
  input: CreateCategoryInput,
): Promise<Category> {
  const response = await http.request({
    method: "POST",
    path: "/admin/categories",
    body: input,
  });
  return parseOrThrow(categorySchema, response);
}

export interface UpdateCategoryInput {
  readonly name: { readonly es: string; readonly en: string };
}

/** Rename only — slug and manual order each have their own route. */
export async function updateCategory(
  http: AdminHttp,
  id: string,
  input: UpdateCategoryInput,
): Promise<Category> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/categories/${id}`,
    body: input,
  });
  return parseOrThrow(categorySchema, response);
}

/**
 * The category tree's manual display order — full replacement, the same
 * "selection order is the value" shape `reorderProducts` above uses.
 */
const reorderCategoriesResultSchema = z.object({ reordered: z.number().int().min(0) }).strict();

export async function reorderCategories(
  http: AdminHttp,
  categoryIds: readonly string[],
): Promise<z.infer<typeof reorderCategoriesResultSchema>> {
  const response = await http.request({
    method: "PUT",
    path: "/admin/categories/reorder",
    body: { categoryIds },
  });
  return parseOrThrow(reorderCategoriesResultSchema, response);
}

/**
 * Soft delete. 204 with no body, matching `deleteProduct` — the status is
 * still checked, because a silently-swallowed 403 would render as a
 * successful delete.
 */
export async function deleteCategory(http: AdminHttp, id: string): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/categories/${id}`,
  });
  parseOrThrow(z.unknown(), response);
}

/**
 * The site-wide admin settings — today, exactly `maintenanceMode`.
 *
 * `GET /admin/site-settings` does not exist; the admin screen reads the SAME
 * public endpoint the storefront's middleware polls
 * (`GET /v1/site-settings`), because there is nothing about the value that
 * needs an authenticated read — only the WRITE is role-gated.
 */
export async function getSiteSettings(http: AdminHttp): Promise<SiteSettings> {
  const response = await http.request({ method: "GET", path: "/site-settings" });
  return parseOrThrow(siteSettingsSchema, response);
}

export async function updateSiteSettings(
  http: AdminHttp,
  input: UpdateSiteSettings,
): Promise<SiteSettings> {
  const response = await http.request({
    method: "PATCH",
    path: "/admin/site-settings",
    body: input,
  });
  return parseOrThrow(siteSettingsSchema, response);
}

export async function listProducts(
  http: AdminHttp,
  params: AdminProductListParams,
): Promise<z.infer<typeof paginatedProductsSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/products",
    query: {
      status: params.status,
      search: params.search,
      category: params.category,
      sort: params.sort,
      includeDeleted: params.includeDeleted,
      locale: params.locale,
      cursor: params.cursor,
      limit: params.limit,
      kind: params.kind,
    },
  });

  return parseOrThrow(paginatedProductsSchema, response);
}

export async function getProduct(
  http: AdminHttp,
  id: string,
): Promise<z.infer<typeof productSchema>> {
  const response = await http.request({ method: "GET", path: `/admin/products/${id}` });
  return parseOrThrow(productSchema, response);
}

/**
 * What a product write hands back, beyond the resource itself.
 *
 * `sanitizedLocales` names every locale whose `description` the API's
 * sanitiser rewrote on this write — see `CONTENT_SANITIZED_HEADER`. Empty,
 * never absent, when nothing was rewritten, so a caller never has to branch
 * on presence versus length.
 */
export interface ProductWrite {
  readonly product: z.infer<typeof productSchema>;
  readonly sanitizedLocales: readonly Locale[];
}

export async function createProduct(
  http: AdminHttp,
  body: CreateProduct,
): Promise<ProductWrite> {
  const response = await http.request({
    method: "POST",
    path: "/admin/products",
    body,
  });
  return {
    product: parseOrThrow(productSchema, response),
    sanitizedLocales: parseSanitizedLocales(response.headers),
  };
}

/**
 * Machine-translate one product's copy from one locale into the other.
 *
 * A READ of a third-party service, not a write of ours: nothing is created and
 * nothing is stored, which is why the API answers 200 rather than 201 and why
 * there is no `revalidatePath` on the action that calls this. The operator sees
 * the result in the form and saves it, or does not.
 *
 * The body is built by the CALLER from `translateRequestSchema`, so every
 * ceiling that stands between this dashboard and a metered vendor account —
 * texts per batch, characters per text, characters per request — is enforced
 * before the request is made, not discovered in the 400 that comes back.
 */
export async function translateCopy(
  http: AdminHttp,
  body: TranslateRequest,
): Promise<TranslateResponse> {
  const response = await http.request({
    method: "POST",
    path: "/admin/translations",
    body,
  });
  return parseOrThrow(translateResponseSchema, response);
}

export async function updateProduct(
  http: AdminHttp,
  id: string,
  body: UpdateProduct,
): Promise<ProductWrite> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/products/${id}`,
    body,
  });
  return {
    product: parseOrThrow(productSchema, response),
    sanitizedLocales: parseSanitizedLocales(response.headers),
  };
}

export async function publishProduct(
  http: AdminHttp,
  id: string,
): Promise<z.infer<typeof productSchema>> {
  const response = await http.request({
    method: "POST",
    path: `/admin/products/${id}/publish`,
  });
  return parseOrThrow(productSchema, response);
}

export async function unpublishProduct(
  http: AdminHttp,
  id: string,
): Promise<z.infer<typeof productSchema>> {
  const response = await http.request({
    method: "POST",
    path: `/admin/products/${id}/unpublish`,
  });
  return parseOrThrow(productSchema, response);
}

/**
 * Soft delete. Returns 204 with no body, so there is nothing to parse — but the
 * status is still checked, because a silently-swallowed 403 would render as a
 * successful delete and the operator would only find out on the next page load.
 */
export async function deleteProduct(http: AdminHttp, id: string): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/products/${id}`,
  });
  parseOrThrow(z.unknown(), response);
}

export async function restoreProduct(
  http: AdminHttp,
  id: string,
): Promise<z.infer<typeof productSchema>> {
  const response = await http.request({
    method: "POST",
    path: `/admin/products/${id}/restore`,
  });
  return parseOrThrow(productSchema, response);
}

/**
 * Adds a new variant to an EXISTING product. Reuses the create shape
 * (`addVariantRequestSchema` is `createVariantSchema` verbatim, matching the
 * API's own `addVariantSchema`).
 */
export async function addVariant(
  http: AdminHttp,
  productId: string,
  body: AddVariantRequest,
): Promise<z.infer<typeof productVariantSchema>> {
  const response = await http.request({
    method: "POST",
    path: `/admin/products/${productId}/variants`,
    body,
  });
  return parseOrThrow(productVariantSchema, response);
}

/**
 * Updates one field or several on an EXISTING variant. `body.version` gates
 * the write with optimistic concurrency — a stale value answers CONFLICT
 * rather than silently overwriting a change made since the form was loaded.
 *
 * Parses the response as `productVariantSchema`, NOT `productSchema` — the
 * API's own handler returns the bare updated `ProductVariant`
 * (`admin-products.controller.ts`'s `updateVariant`), not the whole product.
 * This function previously parsed against `productSchema`, a mismatch that
 * went uncaught only because nothing called it.
 */
export async function updateVariant(
  http: AdminHttp,
  variantId: string,
  body: UpdateVariantRequest,
): Promise<z.infer<typeof productVariantSchema>> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/products/variants/${variantId}`,
    body,
  });
  return parseOrThrow(productVariantSchema, response);
}

export async function adjustInventory(
  http: AdminHttp,
  variantId: string,
  body: AdjustInventoryRequest,
): Promise<void> {
  const response = await http.request({
    method: "POST",
    path: `/admin/products/variants/${variantId}/inventory/adjust`,
    body,
  });
  parseOrThrow(z.unknown(), response);
}

/**
 * Sets a variant's reorder threshold and/or backorder policy — an ABSOLUTE
 * write, unlike `adjustInventory`'s signed delta, because a policy is a
 * setting rather than a ledger balance: "warn me below 5" replaces the old
 * number outright, it does not accumulate.
 */
export async function setInventoryPolicy(
  http: AdminHttp,
  variantId: string,
  body: SetInventoryPolicyRequest,
): Promise<z.infer<typeof inventoryItemSchema>> {
  const response = await http.request({
    method: "PUT",
    path: `/admin/products/variants/${variantId}/inventory/policy`,
    body,
  });
  return parseOrThrow(inventoryItemSchema, response);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface AdminOrderListParams {
  readonly status?: string;
  readonly email?: string;
  readonly orderNumber?: string;
  /** Fulfilment state (`orderShippingFilterSchema`): NO_LABEL / LABEL_CREATED / IN_TRANSIT / ISSUE. */
  readonly shipping?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export async function listOrders(
  http: AdminHttp,
  params: AdminOrderListParams,
): Promise<z.infer<typeof paginatedOrdersSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/orders",
    query: {
      status: params.status,
      email: params.email,
      orderNumber: params.orderNumber,
      shipping: params.shipping,
      cursor: params.cursor,
      limit: params.limit,
    },
  });

  return parseOrThrow(paginatedOrdersSchema, response);
}

export async function getOrder(
  http: AdminHttp,
  orderNumber: string,
): Promise<z.infer<typeof adminOrderSchema>> {
  const response = await http.request({
    method: "GET",
    path: `/admin/orders/${orderNumber}`,
  });
  // `adminOrderSchema`, not `orderSchema`: the admin endpoints send the
  // staff-only fulfilment fields (shipment provider, label, failure detail),
  // which the strict customer shape would reject.
  return parseOrThrow(adminOrderSchema, response);
}

export async function transitionOrder(
  http: AdminHttp,
  orderNumber: string,
  body: TransitionOrderRequest,
): Promise<z.infer<typeof adminOrderSchema>> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/orders/${orderNumber}/status`,
    body,
  });
  // `adminOrderSchema`, not `orderSchema`: the admin endpoints send the
  // staff-only fulfilment fields (shipment provider, label, failure detail),
  // which the strict customer shape would reject.
  return parseOrThrow(adminOrderSchema, response);
}

/**
 * Record a refund INTENT.
 *
 * Carries an `Idempotency-Key` because this is a money-creating POST (spec §9):
 * a double-submitted refund form must replay the first response, not issue a
 * second refund. The key is supplied by the caller so a retry of the SAME user
 * action reuses it — generating one inside this function would make every retry
 * a fresh, non-idempotent request, which is worse than not having a key at all.
 */
export async function requestRefund(
  http: AdminHttp,
  orderNumber: string,
  body: CreateRefundRequest,
  idempotencyKey: string,
): Promise<z.infer<typeof refundSchema>> {
  const response = await http.request({
    method: "POST",
    path: `/admin/orders/${orderNumber}/refunds`,
    body,
    idempotencyKey,
  });
  return parseOrThrow(refundSchema, response);
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface AdminCustomerListParams {
  readonly email?: string;
  readonly role?: Role;
  readonly anonymised?: "true" | "false";
  readonly cursor?: string;
  readonly limit?: number;
}

export async function listCustomers(
  http: AdminHttp,
  params: AdminCustomerListParams,
): Promise<z.infer<typeof paginatedCustomersSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/users",
    query: {
      email: params.email,
      role: params.role,
      anonymised: params.anonymised,
      cursor: params.cursor,
      limit: params.limit,
    },
  });

  return parseOrThrow(paginatedCustomersSchema, response);
}

export async function getCustomer(
  http: AdminHttp,
  customerId: string,
): Promise<z.infer<typeof adminCustomerSchema>> {
  const response = await http.request({
    method: "GET",
    path: `/admin/users/${customerId}`,
  });
  return parseOrThrow(adminCustomerSchema, response);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface MetricsWindowParams {
  readonly from?: string;
  readonly to?: string;
  readonly currency?: string;
}

export async function getMetricsOverview(
  http: AdminHttp,
  params: MetricsWindowParams,
): Promise<z.infer<typeof metricsOverviewSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/overview",
    query: { from: params.from, to: params.to, currency: params.currency },
  });
  return parseOrThrow(metricsOverviewSchema, response);
}

export async function getTopProducts(
  http: AdminHttp,
  params: MetricsWindowParams & { readonly limit?: number },
): Promise<readonly z.infer<typeof topProductSchema>[]> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/top-products",
    query: {
      from: params.from,
      to: params.to,
      currency: params.currency,
      limit: params.limit,
    },
  });
  return parseOrThrow(z.array(topProductSchema), response);
}

export async function getLowStock(
  http: AdminHttp,
  limit?: number,
): Promise<readonly z.infer<typeof lowStockVariantSchema>[]> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/low-stock",
    query: { limit },
  });
  return parseOrThrow(z.array(lowStockVariantSchema), response);
}

export async function getRecentOrders(
  http: AdminHttp,
  limit?: number,
): Promise<readonly z.infer<typeof recentOrderSchema>[]> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/recent-orders",
    query: { limit },
  });
  return parseOrThrow(z.array(recentOrderSchema), response);
}

export async function getRepeatRate(
  http: AdminHttp,
  params: MetricsWindowParams,
): Promise<z.infer<typeof repeatCustomerRateSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/repeat-rate",
    query: { from: params.from, to: params.to, currency: params.currency },
  });
  return parseOrThrow(repeatCustomerRateSchema, response);
}

export async function getReturnsSummary(
  http: AdminHttp,
  params: MetricsWindowParams,
): Promise<z.infer<typeof returnsSummarySchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/returns",
    query: { from: params.from, to: params.to, currency: params.currency },
  });
  return parseOrThrow(returnsSummarySchema, response);
}

export async function getEmailSummary(
  http: AdminHttp,
  params: MetricsWindowParams,
): Promise<z.infer<typeof emailDeliverySummarySchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/emails",
    query: { from: params.from, to: params.to, currency: params.currency },
  });
  return parseOrThrow(emailDeliverySummarySchema, response);
}

/** The series behind the revenue tiles — one point per UTC day in the window. */
export async function getRevenueSeries(
  http: AdminHttp,
  params: MetricsWindowParams,
): Promise<readonly z.infer<typeof dailyRevenuePointSchema>[]> {
  const response = await http.request({
    method: "GET",
    path: "/admin/metrics/revenue-series",
    query: { from: params.from, to: params.to, currency: params.currency },
  });
  return parseOrThrow(z.array(dailyRevenuePointSchema), response);
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

export interface AdminDiscountListParams {
  readonly includeDeleted?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export async function listDiscounts(
  http: AdminHttp,
  params: AdminDiscountListParams,
): Promise<z.infer<typeof paginatedDiscountsSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/discounts",
    query: {
      includeDeleted: params.includeDeleted,
      cursor: params.cursor,
      limit: params.limit,
    },
  });

  return parseOrThrow(paginatedDiscountsSchema, response);
}

export async function getDiscount(
  http: AdminHttp,
  id: string,
): Promise<z.infer<typeof adminDiscountSchema>> {
  const response = await http.request({ method: "GET", path: `/admin/discounts/${id}` });
  return parseOrThrow(adminDiscountSchema, response);
}

/**
 * Create a coupon.
 *
 * NO `Idempotency-Key`, unlike `requestRefund`. This POST creates no money and
 * the API rejects a duplicate `code` with a 409 of its own, so the unique column
 * already makes a double submission safe — and minting a key here would give the
 * operator a REPLAYED success for the second click of a genuinely different code
 * only if the body matched, which it would not. The conflict is the better
 * signal: it names the code that already exists.
 */
export async function createDiscount(
  http: AdminHttp,
  body: CreateDiscountRequest,
): Promise<z.infer<typeof adminDiscountSchema>> {
  const response = await http.request({
    method: "POST",
    path: "/admin/discounts",
    body,
  });
  return parseOrThrow(adminDiscountSchema, response);
}

export async function updateDiscount(
  http: AdminHttp,
  id: string,
  body: UpdateDiscountRequest,
): Promise<z.infer<typeof adminDiscountSchema>> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/discounts/${id}`,
    body,
  });
  return parseOrThrow(adminDiscountSchema, response);
}

/**
 * Soft delete (archive). Returns 204 with no body, so there is nothing to parse
 * — but the status is still checked, for the same reason `deleteProduct` checks
 * it: a swallowed 403 renders as a successful archive and the coupon keeps being
 * redeemable until someone notices.
 */
export async function deleteDiscount(http: AdminHttp, id: string): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/discounts/${id}`,
  });
  parseOrThrow(z.unknown(), response);
}

// ---------------------------------------------------------------------------
// Affiliates — §14 of docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md.
// Coupon assignment is NOT here — it is `updateDiscount` above, widened with
// `affiliateId`. See `AdminAffiliatesController`'s own doc comment for why.
// ---------------------------------------------------------------------------

export interface AdminAffiliateListParams {
  readonly includeDeleted?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export async function listAffiliates(
  http: AdminHttp,
  params: AdminAffiliateListParams,
): Promise<z.infer<typeof paginatedAffiliatesSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/affiliates",
    query: {
      includeDeleted: params.includeDeleted,
      cursor: params.cursor,
      limit: params.limit,
    },
  });

  return parseOrThrow(paginatedAffiliatesSchema, response);
}

export async function getAffiliate(
  http: AdminHttp,
  id: string,
): Promise<z.infer<typeof adminAffiliateSchema>> {
  const response = await http.request({ method: "GET", path: `/admin/affiliates/${id}` });
  return parseOrThrow(adminAffiliateSchema, response);
}

export async function createAffiliate(
  http: AdminHttp,
  body: CreateAffiliateRequest,
): Promise<z.infer<typeof adminAffiliateSchema>> {
  const response = await http.request({
    method: "POST",
    path: "/admin/affiliates",
    body,
  });
  return parseOrThrow(adminAffiliateSchema, response);
}

export async function updateAffiliate(
  http: AdminHttp,
  id: string,
  body: UpdateAffiliateRequest,
): Promise<z.infer<typeof adminAffiliateSchema>> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/affiliates/${id}`,
    body,
  });
  return parseOrThrow(adminAffiliateSchema, response);
}

/** Soft delete. Returns 204 with no body — the status is still checked, same reasoning `deleteDiscount` gives for its own identical call. */
export async function deleteAffiliate(http: AdminHttp, id: string): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/affiliates/${id}`,
  });
  parseOrThrow(z.unknown(), response);
}

/**
 * Activate this affiliate's partner dashboard login, or resend the
 * password-setup email if one is already active — ONE endpoint for both, see
 * `AffiliateAdminService.activatePartnerLogin`'s own doc comment.
 */
export async function activatePartnerLogin(
  http: AdminHttp,
  affiliateId: string,
): Promise<PartnerLoginStatus> {
  const response = await http.request({
    method: "POST",
    path: `/admin/affiliates/${affiliateId}/activate-login`,
  });
  return parseOrThrow(partnerLoginStatusSchema, response);
}

// ---------------------------------------------------------------------------
// Partner (vanity) links
// ---------------------------------------------------------------------------

export async function listAffiliateLinks(
  http: AdminHttp,
  affiliateId: string,
): Promise<readonly AdminAffiliateLink[]> {
  const response = await http.request({
    method: "GET",
    path: `/admin/affiliates/${affiliateId}/links`,
  });
  return parseOrThrow(z.array(adminAffiliateLinkSchema), response);
}

export async function createAffiliateLink(
  http: AdminHttp,
  affiliateId: string,
  body: CreateAffiliateLinkRequest,
): Promise<AdminAffiliateLink> {
  const response = await http.request({
    method: "POST",
    path: `/admin/affiliates/${affiliateId}/links`,
    body,
  });
  return parseOrThrow(adminAffiliateLinkSchema, response);
}

/** Soft delete. Returns 204 with no body, same convention as `deleteAffiliate`. */
export async function deleteAffiliateLink(
  http: AdminHttp,
  affiliateId: string,
  linkId: string,
): Promise<void> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/affiliates/${affiliateId}/links/${linkId}`,
  });
  parseOrThrow(z.unknown(), response);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface AdminInventoryListParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly filter?: InventoryFilter;
  readonly search?: string;
  readonly locale?: Locale;
}

/**
 * Stock across every variant, including the ones with NO inventory record.
 *
 * Read-only by design: adjusting a level and changing a variant's policy already
 * exist under `/admin/products/variants/:variantId/inventory*`, with the
 * conditional-UPDATE guards that make them safe under concurrency. A second
 * write path to the same rows would be a second place to get that wrong.
 */
export async function listInventory(
  http: AdminHttp,
  params: AdminInventoryListParams,
): Promise<z.infer<typeof paginatedInventorySchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/inventory",
    query: {
      // Spread rather than assigned: `buildQueryString` serialises anything that
      // is not `undefined`, so an explicit undefined would become the STRING
      // "undefined" in the query.
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      ...(params.search === undefined ? {} : { search: params.search }),
      ...(params.filter === undefined ? {} : { filter: params.filter }),
      ...(params.locale === undefined ? {} : { locale: params.locale }),
      limit: params.limit,
    },
  });

  return parseOrThrow(paginatedInventorySchema, response);
}

// ---------------------------------------------------------------------------
// Email log
// ---------------------------------------------------------------------------

export const paginatedEmailEventsSchema = paginatedSchema(emailEventSchema);

export interface AdminEmailListParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly status?: EmailStatus;
  readonly recipient?: string;
}

/** The delivery log: one row per send attempt, with its provider-side status. */
export async function listEmailEvents(
  http: AdminHttp,
  params: AdminEmailListParams,
): Promise<z.infer<typeof paginatedEmailEventsSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/emails",
    query: {
      // Spread rather than assigned: `buildQueryString` serialises anything not
      // `undefined`, so an explicit undefined becomes the STRING "undefined".
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.recipient === undefined ? {} : { recipient: params.recipient }),
      limit: params.limit,
    },
  });

  return parseOrThrow(paginatedEmailEventsSchema, response);
}

export async function getEmailEvent(http: AdminHttp, id: string): Promise<EmailEvent> {
  const response = await http.request({ method: "GET", path: `/admin/emails/${id}` });
  return parseOrThrow(emailEventSchema, response);
}

// ---------------------------------------------------------------------------
// Background jobs (outbox)
// ---------------------------------------------------------------------------

export const paginatedJobsListSchema = paginatedSchema(jobSchema);

export interface AdminJobListParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly state?: JobState;
  readonly topic?: string;
}

export async function listJobs(
  http: AdminHttp,
  params: AdminJobListParams,
): Promise<z.infer<typeof paginatedJobsListSchema>> {
  const response = await http.request({
    method: "GET",
    path: "/admin/jobs",
    query: {
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      ...(params.state === undefined ? {} : { state: params.state }),
      ...(params.topic === undefined ? {} : { topic: params.topic }),
      limit: params.limit,
    },
  });

  return parseOrThrow(paginatedJobsListSchema, response);
}

/** Per-topic backlog. Cheap enough to fetch beside the list on every load. */
export async function getJobsSummary(http: AdminHttp): Promise<JobsSummary> {
  const response = await http.request({ method: "GET", path: "/admin/jobs/summary" });
  return parseOrThrow(jobsSummarySchema, response);
}

// ---------------------------------------------------------------------------
// Product media
// ---------------------------------------------------------------------------

export const uploadUrlSchema = z
  .object({
    uploadUrl: z.string().url(),
    objectKey: z.string().min(1),
    /** Where the object is readable once the upload completes. */
    publicUrl: z.string().url(),
    expiresInSeconds: z.number().int().positive(),
  })
  .strict();

export interface CreateUploadUrlInput {
  readonly productId: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/**
 * Issues a short-lived signed URL the BROWSER uploads to directly.
 *
 * The file never passes through this app or the API — that is the entire point
 * of presigning. A 1 MB product photo relayed through two Node processes is two
 * copies in memory and a request-body limit to raise on both; the signed URL
 * moves the bytes straight to storage and keeps the credential server-side.
 */
export async function createMediaUploadUrl(
  http: AdminHttp,
  input: CreateUploadUrlInput,
): Promise<z.infer<typeof uploadUrlSchema>> {
  const response = await http.request({
    method: "POST",
    path: "/admin/media/upload-url",
    body: input,
  });

  return parseOrThrow(uploadUrlSchema, response);
}

export interface AddProductMediaInput {
  readonly objectKey: string;
  readonly url: string;
  /** Per-locale alt text; it is user-facing copy like any other. */
  readonly alt: Record<string, string>;
  readonly width: number;
  readonly height: number;
  readonly sortOrder: number;
  /**
   * Attach to ONE variant instead of the product gallery.
   *
   * Absent for a gallery image, which is what a card in a grid and the product
   * hero fall back to. The API verifies the variant belongs to THIS product
   * before it writes — the same ownership discipline as `removeProductMedia`'s
   * two-id scoping, and for the same reason: an operator holding one product's
   * id must not be able to reach another product's variant by guessing a uuid.
   */
  readonly variantId?: string;
}

export async function addProductMedia(
  http: AdminHttp,
  productId: string,
  input: AddProductMediaInput,
): Promise<z.infer<typeof productSchema>> {
  const response = await http.request({
    method: "POST",
    path: `/admin/products/${productId}/media`,
    body: input,
  });

  return parseOrThrow(productSchema, response);
}

export async function removeProductMedia(
  http: AdminHttp,
  productId: string,
  mediaId: string,
): Promise<z.infer<typeof productSchema>> {
  const response = await http.request({
    method: "DELETE",
    path: `/admin/products/${productId}/media/${mediaId}`,
  });

  return parseOrThrow(productSchema, response);
}

// ---------------------------------------------------------------------------
// Blog — spec 2026-09-24 §8. Every response parsed against @akai/contracts.
// ---------------------------------------------------------------------------

export interface ListBlogPostsInput {
  readonly status?: BlogPostStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export async function listBlogPosts(
  http: AdminHttp,
  input: ListBlogPostsInput = {},
): Promise<AdminBlogPostListResponse> {
  const response = await http.request({
    method: "GET",
    path: "/admin/blog/posts",
    query: {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
  });
  return parseOrThrow(adminBlogPostListResponseSchema, response);
}

export async function getBlogPost(http: AdminHttp, id: string): Promise<AdminBlogPost> {
  const response = await http.request({ method: "GET", path: `/admin/blog/posts/${id}` });
  return parseOrThrow(adminBlogPostSchema, response);
}

export async function createBlogPost(
  http: AdminHttp,
  input: CreateBlogPost,
): Promise<AdminBlogPost> {
  const response = await http.request({ method: "POST", path: "/admin/blog/posts", body: input });
  return parseOrThrow(adminBlogPostSchema, response);
}

export async function updateBlogPost(
  http: AdminHttp,
  id: string,
  input: UpdateBlogPost,
): Promise<AdminBlogPost> {
  const response = await http.request({
    method: "PATCH",
    path: `/admin/blog/posts/${id}`,
    body: input,
  });
  return parseOrThrow(adminBlogPostSchema, response);
}

export async function setBlogPostPublished(
  http: AdminHttp,
  id: string,
  published: boolean,
): Promise<AdminBlogPost> {
  const response = await http.request({
    method: "POST",
    path: `/admin/blog/posts/${id}/${published ? "publish" : "unpublish"}`,
  });
  return parseOrThrow(adminBlogPostSchema, response);
}

/** Hard delete, 204 — the status is still checked so a 403 is never a silent success. */
export async function deleteBlogPost(http: AdminHttp, id: string): Promise<void> {
  const response = await http.request({ method: "DELETE", path: `/admin/blog/posts/${id}` });
  parseOrThrow(z.unknown(), response);
}

export async function createBlogCoverUploadUrl(
  http: AdminHttp,
  id: string,
  input: BlogCoverUploadUrlRequest,
): Promise<ImageUploadUrlResponse> {
  const response = await http.request({
    method: "POST",
    path: `/admin/blog/posts/${id}/cover/upload-url`,
    body: input,
  });
  return parseOrThrow(imageUploadUrlResponseSchema, response);
}
