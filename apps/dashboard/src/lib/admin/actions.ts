"use server";

import { revalidatePath } from "next/cache";
import {
  blogCoverUploadUrlRequestSchema,
  createBlogPostSchema,
  offerEverywhereSchema,
  translateRequestSchema,
  updateBlogPostSchema,
  updateProductSchema,
  type BlogCoverUploadUrlRequest,
  type BlogPostStatus,
  type CreateBlogPost,
  type CreateProduct,
  type UpdateBlogPost,
  type ErrorCode,
  type Locale,
  type OfferEverywhereResult,
  type OrderStatus,
  type UpdateSiteSettings,
  createShipmentSchema,
  idSchema,
  type AdminShippingRate,
  type AdminShippingZoneDetail,
  type CreateShipment,
  type ShipmentStatus,
} from "@akai/contracts";
import { apiBaseUrl, createApiClient } from "../api/client";
import { refresh as refreshTokens } from "../api/auth";
import { clearSession, getSession, writeSession } from "../session/server";
import { applyRefreshedTokens, type SessionPayload } from "@akai/session";
import { createAdminHttp } from "./http-adapter";
import { AdminApiError, type AdminHttp, type AdminHttpRequest } from "./http";
import * as api from "./api";
import * as shippingApi from "./shipping-api";
import {
  mergeBlogTranslations,
  toBlogTranslationTexts,
  translateBlogCopyInputSchema,
  type BlogCopy,
} from "./blog-copy";
import {
  mergeTranslations,
  toTranslationTexts,
  translateCopyInputSchema,
  type ProductCopy,
} from "./translate-copy";
import {
  addVariantRequestSchema,
  adjustInventoryRequestSchema,
  createAffiliateLinkRequestSchema,
  createAffiliateRequestSchema,
  createDiscountRequestSchema,
  createRefundRequestSchema,
  setInventoryPolicyRequestSchema,
  transitionOrderRequestSchema,
  updateAffiliateRequestSchema,
  updateDiscountRequestSchema,
  updateVariantRequestSchema,
  type AdminAffiliateLink,
  type CreateAffiliateLinkRequest,
  type CreateAffiliateRequest,
  type CreateDiscountRequest,
  type CreateRefundRequest,
  type PartnerLoginStatus,
  type UpdateAffiliateRequest,
  type UpdateDiscountRequest,
} from "./schemas";

/**
 * Server actions backing the admin forms.
 *
 * WHY ACTIONS AND NOT ROUTE HANDLERS: the mutation runs in the same server
 * context that already holds the sealed session, so no token, base URL or CSRF
 * token is ever handed to the browser. A client component calls a typed function
 * and receives a typed result; the credential never leaves the server.
 *
 * EVERY ACTION RE-VALIDATES ITS INPUT. A server action is a public HTTP endpoint
 * with a generated name — it is NOT protected by the fact that only one
 * component calls it, and it is reachable by anyone who can read the page's JS
 * bundle. So each one parses its argument against the same schema the API uses
 * before forwarding it. The API validates again, and the DB constrains again;
 * this is the outermost of three, not the only one.
 *
 * They also do NOT re-check the role. That is deliberate rather than an
 * omission: the API's RolesGuard re-reads the role from the database session row
 * on every request, so a check here could only ever be a weaker, staler copy of
 * a decision that is made correctly downstream. The admin layout's assertion
 * governs RENDERING; authorisation belongs to the API.
 */

/**
 * Exchanges the session's refresh token for a new pair and persists it.
 *
 * MIRRORS `middleware.ts`'s OWN `rotate()`, and shares its merge step
 * (`applyRefreshedTokens`) rather than duplicating the field list. The two
 * differ only in what they may do with the result: middleware writes a cookie
 * onto the response it is already building, and this writes one via
 * `writeSession` — legal here because every caller of `adminHttp()` is a
 * Server Action, not a server component (see `createServerApiClient`'s own
 * note on why IT must never do this).
 *
 * Returns `null` on a refresh failure (the refresh token is expired, revoked,
 * or was already spent by a concurrent request) and clears the session so the
 * dead cookie cannot cause a redirect loop on the next navigation — the exact
 * reasoning `clearSession`'s own doc comment gives for the middleware case.
 */
async function refreshSession(session: SessionPayload): Promise<SessionPayload | null> {
  const result = await refreshTokens({ baseUrl: apiBaseUrl() }, session.refreshToken);
  if (!result.ok) {
    await clearSession();
    return null;
  }

  const refreshed = applyRefreshedTokens(session, result.data.tokens);
  await writeSession(refreshed);
  return refreshed;
}

/**
 * The admin HTTP port, with ONE retry on an expired access token.
 *
 * WHY HERE, AND NOT IN `createServerApiClient`. That client is shared with
 * server COMPONENTS reading data on a GET, where a mid-render cookie write is
 * illegal — its own doc comment says a 401 there means the session genuinely
 * died. Every caller of `adminHttp()`, by contrast, is a Server Action: cookie
 * writes are legal, and a POST/PATCH that 401s because a 15-minute access
 * token expired while an operator was filling in a long form (item 1d's own
 * form, among others) is exactly the case worth one retry for, not a redirect.
 *
 * THE RETRY IS EXACTLY ONE, tied to one specific failed request, never a
 * background timer or a retry loop. `middleware.ts`'s own `shouldAttemptRefresh`
 * deliberately skips every non-GET for a documented reason: two concurrent
 * requests racing to spend the same single-use refresh token can trigger false
 * replay-detection logouts. That risk still exists here, narrowed to the rare
 * case of two stale-token Server Actions landing at once — accepted, because
 * the fallback is graceful: `refreshSession` returns `null`, this returns the
 * ORIGINAL 401 unchanged, and the caller sees the correct "session expired,
 * sign in again" message (see `messageFor` in `product-editor.tsx`) rather than
 * a retry that could loop.
 */
async function adminHttp(): Promise<AdminHttp> {
  const session = await getSession();
  const admin = createAdminHttp(createApiClient(apiBaseUrl(), session));

  if (session === null) {
    return admin;
  }

  return {
    async request(input: AdminHttpRequest) {
      const result = await admin.request(input);
      if (result.status !== 401) {
        return result;
      }

      const refreshed = await refreshSession(session);
      if (refreshed === null) {
        return result;
      }

      return createAdminHttp(createApiClient(apiBaseUrl(), refreshed)).request(input);
    },
  };
}

/**
 * The machine-readable half of a failure.
 *
 * `ErrorCode` is the platform's closed enum; `UNPARSEABLE_RESPONSE` is
 * `AdminApiError`'s own addition for a body this dashboard cannot read. `null`
 * means the throw was not an API failure at all (a zod refusal in the action
 * itself, a network object with no envelope), and a caller must fall back to a
 * generic message for it.
 */
export type ActionErrorCode = ErrorCode | "UNPARSEABLE_RESPONSE";

/**
 * A uniform result so a client component can render failures without try/catch.
 *
 * THE FAILURE BRANCH CARRIES THE CODE, and that is not decoration. `message` is
 * the API's own English — "A discount with code SAVE10 already exists." — written
 * for a log, not for an operator, and rendering it violates the repo's
 * never-show-a-server-message rule. A client that receives only `message` has no
 * way to obey that rule: it cannot tell a duplicate code (CONFLICT) from a
 * rejected value (VALIDATION_FAILED) from a revoked session (UNAUTHENTICATED),
 * so it either prints the server's string or says "something went wrong" to all
 * three. With `code` present it branches on a CLOSED enum against the message
 * catalog, and a new code becomes a compile error at the total `Record` that
 * maps them.
 *
 * `message` is KEPT, deliberately: existing callers (`ProductEditor`) still read
 * it, it is what a developer needs in a console or a bug report, and dropping it
 * would be a breaking change for no gain. New surfaces render `code`; `message`
 * is diagnostic.
 */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly code: ActionErrorCode | null;
      /** The envelope's domain sub-code, or null. An identifier, never rendered. */
      readonly reason: string | null;
      /** Diagnostic. Server-authored English — do NOT render it to an operator. */
      readonly message: string;
    };

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (cause) {
    // Both halves survive the boundary: the code so a client can branch, the
    // message so a developer can read what actually happened.
    return {
      ok: false,
      code: cause instanceof AdminApiError ? cause.code : null,
      reason: cause instanceof AdminApiError ? cause.reason : null,
      message: cause instanceof Error ? cause.message : "The request failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * What a create hands back.
 *
 * THE VARIANTS ARE RETURNED BECAUSE THE CALLER HAS FILES TO PLACE. An image
 * staged against a variant on the create form has no variant id to attach to
 * until this call returns — the ids are minted server-side — and the caller must
 * be able to say WHICH variant each file belongs to. The SKU travels with the id
 * so that mapping is done by the value the operator typed rather than by array
 * position, which the API is under no obligation to preserve.
 */
export interface CreatedProduct {
  readonly id: string;
  readonly variants: readonly { readonly id: string; readonly sku: string }[];
  /** Locales whose description the API's sanitiser rewrote. Empty when nothing changed. */
  readonly sanitizedLocales: readonly Locale[];
}

export async function createProductAction(
  input: CreateProduct,
): Promise<ActionResult<CreatedProduct>> {
  const result = await run(async () => {
    const http = await adminHttp();
    const { product, sanitizedLocales } = await api.createProduct(http, input);
    revalidatePath("/admin/products");
    return {
      id: product.id,
      variants: product.variants.map((variant) => ({ id: variant.id, sku: variant.sku })),
      sanitizedLocales,
    };
  });

  return result;
}

export async function updateProductAction(
  id: string,
  input: CreateProduct,
): Promise<ActionResult<{ id: string; sanitizedLocales: readonly Locale[] }>> {
  return run(async () => {
    const http = await adminHttp();

    // `updateProduct` takes the partial shape; variants are edited through their
    // own endpoint because each carries an optimistic-concurrency `version`.
    //
    // DERIVED FROM THE SCHEMA, NOT RESTATED. This was a hand-written list of six
    // keys, and it silently omitted `listed` — so the sidebar's storefront-
    // visibility control did nothing at all on an existing product, and an
    // add-on could be created but never un-made. Parsing instead means a field
    // added to `createProductSchema` reaches the PATCH on its own, and one the
    // update shape does not accept fails loudly here rather than vanishing.
    //
    // `variants` is DELETED rather than destructured away, and rather than set to
    // undefined. `updateProductSchema` is `.strict()`, so the key is rejected
    // even carrying `undefined` — and a rest-sibling binding for a value nobody
    // reads is an unused variable the linter is right to flag.
    const updatable: Record<string, unknown> = { ...input };
    delete updatable["variants"];

    const { product, sanitizedLocales } = await api.updateProduct(
      http,
      id,
      updateProductSchema.parse(updatable),
    );

    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${id}`);
    return { id: product.id, sanitizedLocales };
  });
}

export async function deleteProductAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.deleteProduct(http, id);
    revalidatePath("/admin/products");
    return null;
  });
}

export async function restoreProductAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.restoreProduct(http, id);
    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${id}`);
    return null;
  });
}

export async function publishProductAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.publishProduct(http, id);
    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${id}`);
    return null;
  });
}

/**
 * Offer this add-on on every existing product page.
 *
 * SEPARATE FROM THE SAVE, and called after it. The two are different writes with
 * different failure modes: the product itself saving is what the operator asked
 * for, and a failure to fan the add-on out across the catalogue must not be
 * reported as "the product was not saved" — it was. The caller surfaces the
 * counts, or the fan-out's own failure, without touching the save's result.
 *
 * Parsed, not trusted. A server action is a public endpoint with a generated
 * name, reachable by anyone who reads the page bundle.
 */
export async function offerProductEverywhereAction(
  id: string,
  input: unknown,
): Promise<ActionResult<OfferEverywhereResult>> {
  return run(async () => {
    const body = offerEverywhereSchema.parse(input);
    const http = await adminHttp();
    const result = await api.offerEverywhere(http, id, body);

    // Every product page's admin view now lists one more add-on, and the
    // storefront revalidation is enqueued API-side by the service itself.
    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${id}`);

    return result;
  });
}

export async function unpublishProductAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.unpublishProduct(http, id);
    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${id}`);
    return null;
  });
}

export async function adjustInventoryAction(
  variantId: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    // Parsed, not trusted. A server action is a public endpoint with a
    // generated name, reachable by anyone who reads the page bundle.
    const body = adjustInventoryRequestSchema.parse(input);
    const http = await adminHttp();
    await api.adjustInventory(http, variantId, body);
    // Both surfaces that render the count. The inventory list has its own
    // Adjust action, and a stale count there is exactly what `expectedOnHand`
    // would refuse on the next attempt.
    revalidatePath("/admin/products");
    revalidatePath("/admin/inventory");
    return null;
  });
}

/**
 * Adds a variant to an EXISTING product — the counterpart to the variant rows
 * `createProductAction` seeds at create time. Returns the id/sku pair the
 * caller needs to match a staged photo onto the row it was added to, the same
 * principle `CreatedProduct.variants` already uses.
 */
export async function addVariantAction(
  productId: string,
  input: unknown,
): Promise<ActionResult<{ id: string; sku: string }>> {
  return run(async () => {
    const body = addVariantRequestSchema.parse(input);
    const http = await adminHttp();
    const variant = await api.addVariant(http, productId, body);
    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${productId}`);
    return { id: variant.id, sku: variant.sku };
  });
}

/**
 * Updates one or more fields on an EXISTING variant. `input.version` gates the
 * write — a stale value answers `CONFLICT`, which the caller (`ProductEditor`)
 * reports per-row rather than as a whole-save failure, since the product's own
 * fields were already saved by the time this runs.
 */
export async function updateVariantAction(
  variantId: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const body = updateVariantRequestSchema.parse(input);
    const http = await adminHttp();
    await api.updateVariant(http, variantId, body);
    revalidatePath("/admin/products");
    return null;
  });
}

/**
 * Sets a variant's reorder threshold and/or backorder policy. Separate from
 * `updateVariantAction` because it is a SEPARATE API endpoint with no version
 * token — a policy is a setting, not a versioned resource.
 */
export async function setVariantInventoryPolicyAction(
  variantId: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const body = setInventoryPolicyRequestSchema.parse(input);
    const http = await adminHttp();
    await api.setInventoryPolicy(http, variantId, body);
    revalidatePath("/admin/products");
    return null;
  });
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Machine-translate one product's copy into the locale the form is showing.
 *
 * A SERVER ACTION RATHER THAN A BROWSER FETCH, for two reasons that do not
 * overlap. The admin bearer is held server-side and stays there, as it does for
 * every other action in this file. And the endpoint behind it spends money at a
 * metered vendor per character: reachable from the browser it would be one
 * runaway effect away from an invoice, whereas here the vendor is only ever
 * addressed by a caller the API has already authenticated as an operator, with
 * the contract's ceilings applied before anything is sent.
 *
 * IT PREFILLS; IT NEVER SAVES. Nothing in this function writes a product row.
 * The operator reads what came back, edits it, and saves deliberately — a
 * machine translation of customer-facing copy going live unreviewed is a
 * compliance problem, not a convenience, and the form marks the filled fields
 * as unreviewed until a human touches them.
 */
export async function translateProductCopyAction(
  input: unknown,
): Promise<ActionResult<ProductCopy>> {
  const parsed = translateCopyInputSchema.safeParse(input);
  if (!parsed.success) {
    // No `reason`: the caller sent a shape this action does not accept, which
    // is a client bug rather than one of the closed states an operator can be
    // told something useful about.
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: null,
      message: "The translation request was rejected before it was sent.",
    };
  }

  const texts = toTranslationTexts(parsed.data.copy);
  if (texts.length === 0) {
    // ANSWERED WITHOUT A REQUEST. An all-blank source can only translate to
    // nothing, and the vendor bills for being asked. The form disables the
    // button in this state too; this is the half of the guard that survives a
    // caller who is not the form.
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: "EMPTY_SOURCE",
      message: "There is nothing to translate.",
    };
  }

  const body = translateRequestSchema.safeParse({
    source: parsed.data.from,
    target: parsed.data.to,
    texts,
  });
  if (!body.success) {
    // The contract's own ceilings — per text, per batch — reached before the
    // request rather than in the 400 that would come back from it.
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: null,
      message: "The copy is outside the bounds the translation endpoint accepts.",
    };
  }

  return run(async () => {
    const http = await adminHttp();
    const response = await api.translateCopy(http, body.data);
    // Blank fields were dropped on the way out; they come back blank rather
    // than carrying the source language's text into the other locale's box.
    return mergeTranslations(response.translations);
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export async function transitionOrderAction(
  orderNumber: string,
  status: OrderStatus,
  note: string | undefined,
): Promise<ActionResult<{ status: OrderStatus }>> {
  return run(async () => {
    const body = transitionOrderRequestSchema.parse({
      status,
      ...(note === undefined ? {} : { note }),
    });

    const http = await adminHttp();
    const order = await api.transitionOrder(http, orderNumber, body);

    revalidatePath("/admin/orders");
    revalidatePath(`/admin/orders/${orderNumber}`);
    return { status: order.status };
  });
}

export async function requestRefundAction(
  orderNumber: string,
  input: CreateRefundRequest,
  idempotencyKey: string,
): Promise<ActionResult<{ refundId: string }>> {
  return run(async () => {
    const body = createRefundRequestSchema.parse(input);
    const http = await adminHttp();

    // The key is forwarded from the client, NOT generated here. One user action
    // must map to one key across every retry, and an action invocation is one
    // attempt — minting a key here would make each retry a fresh, non-idempotent
    // money-creating request (spec §9).
    const refund = await api.requestRefund(http, orderNumber, body, idempotencyKey);

    revalidatePath(`/admin/orders/${orderNumber}`);
    return { refundId: refund.id };
  });
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

/**
 * Create a coupon.
 *
 * The argument is TYPED and still RE-PARSED. Typed so the one legitimate caller
 * cannot assemble a wrong shape; re-parsed because a server action is a public
 * HTTP endpoint with a generated name and the type annotation is erased at
 * runtime — anyone who can read the page bundle can invoke this with anything.
 * The API parses it a third time with the identical `.strict()` schema.
 */
export async function createDiscountAction(
  input: CreateDiscountRequest,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const body = createDiscountRequestSchema.parse(input);
    const http = await adminHttp();
    const discount = await api.createDiscount(http, body);
    revalidatePath("/admin/discounts");
    return { id: discount.id };
  });
}

/**
 * Update a coupon.
 *
 * `code` is absent from the body by construction — the schema has no such key
 * and it is `.strict()`, so an attempt to rename a live coupon is rejected here
 * as well as server-side. Renaming would invalidate every printed card and
 * affiliate link already carrying the old string.
 */
export async function updateDiscountAction(
  id: string,
  input: UpdateDiscountRequest,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const body = updateDiscountRequestSchema.parse(input);
    const http = await adminHttp();
    const discount = await api.updateDiscount(http, id, body);
    revalidatePath("/admin/discounts");
    revalidatePath(`/admin/discounts/${id}`);
    return { id: discount.id };
  });
}

/** Archive a coupon. Soft: past redemptions reference it forever. */
export async function deleteDiscountAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.deleteDiscount(http, id);
    revalidatePath("/admin/discounts");
    revalidatePath(`/admin/discounts/${id}`);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Affiliates — §14. Coupon assignment reuses `updateDiscountAction` above
// (widened with `affiliateId`); there is no separate assignment action.
// ---------------------------------------------------------------------------

export async function createAffiliateAction(
  input: CreateAffiliateRequest,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const body = createAffiliateRequestSchema.parse(input);
    const http = await adminHttp();
    const affiliate = await api.createAffiliate(http, body);
    revalidatePath("/admin/affiliates");
    return { id: affiliate.id };
  });
}

export async function updateAffiliateAction(
  id: string,
  input: UpdateAffiliateRequest,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const body = updateAffiliateRequestSchema.parse(input);
    const http = await adminHttp();
    const affiliate = await api.updateAffiliate(http, id, body);
    revalidatePath("/admin/affiliates");
    revalidatePath(`/admin/affiliates/${id}`);
    return { id: affiliate.id };
  });
}

/** Soft delete. A coupon still assigned to this affiliate blocks nothing here — see `AffiliateAdminService.softDelete`, which does not check for one at all; the coupon simply keeps pointing at a now-archived affiliate. */
export async function deleteAffiliateAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.deleteAffiliate(http, id);
    revalidatePath("/admin/affiliates");
    revalidatePath(`/admin/affiliates/${id}`);
    return null;
  });
}

/**
 * Activate this affiliate's partner dashboard login, or resend the
 * password-setup email if one is already active. Revalidates the detail page
 * so `hasLogin` reflects the new state on the next render.
 */
export async function activatePartnerLoginAction(
  affiliateId: string,
): Promise<ActionResult<PartnerLoginStatus>> {
  return run(async () => {
    const http = await adminHttp();
    const status = await api.activatePartnerLogin(http, affiliateId);
    revalidatePath(`/admin/affiliates/${affiliateId}`);
    return status;
  });
}

export async function createAffiliateLinkAction(
  affiliateId: string,
  input: CreateAffiliateLinkRequest,
): Promise<ActionResult<AdminAffiliateLink>> {
  return run(async () => {
    const body = createAffiliateLinkRequestSchema.parse(input);
    const http = await adminHttp();
    const link = await api.createAffiliateLink(http, affiliateId, body);
    revalidatePath(`/admin/affiliates/${affiliateId}`);
    return link;
  });
}

export async function deleteAffiliateLinkAction(
  affiliateId: string,
  linkId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.deleteAffiliateLink(http, affiliateId, linkId);
    revalidatePath(`/admin/affiliates/${affiliateId}`);
    return null;
  });
}

/*
 * NOTE — there is deliberately no `createProductAndRedirect` here.
 *
 * `redirect()` works by THROWING a control-flow signal that Next catches. Inside
 * this module every action body runs through `run()`, whose catch would swallow
 * that signal and report a successful creation as a failed action — stranding
 * the operator on the create form beside a product that was, in fact, created.
 * Navigation after a create therefore belongs to the client boundary
 * (`ProductEditor`), which knows the new id and can navigate without fighting
 * the error handling.
 */

// ---------------------------------------------------------------------------
// Product media
// ---------------------------------------------------------------------------

/**
 * Issues the signed URL the browser uploads to.
 *
 * A SERVER ACTION because presigning needs the admin bearer, and that must not
 * reach the browser. The signed URL it returns carries its own authority and a
 * ten-minute expiry, so handing THAT to the browser is safe — it grants exactly
 * one PUT to exactly one object key.
 */
export async function createMediaUploadUrlAction(
  input: api.CreateUploadUrlInput,
): Promise<ActionResult<Awaited<ReturnType<typeof api.createMediaUploadUrl>>>> {
  return run(async () => {
    const http = await adminHttp();
    return api.createMediaUploadUrl(http, input);
  });
}

/**
 * Records an uploaded object against the product.
 *
 * Separate from the upload on purpose: the bytes are already in storage by the
 * time this runs, so a failure here leaves an orphaned object rather than a
 * half-written product. That is the cheaper of the two failures to clean up.
 */
export async function addProductMediaAction(
  productId: string,
  input: api.AddProductMediaInput,
): Promise<ActionResult<{ id: string }>> {
  const result = await run(async () => {
    const http = await adminHttp();
    await api.addProductMedia(http, productId, input);
    return { id: productId };
  });

  if (result.ok) {
    // The product page is server-rendered, so without this the new image would
    // not appear until a manual reload.
    revalidatePath(`/admin/products/${productId}`);
  }
  return result;
}

export async function removeProductMediaAction(
  productId: string,
  mediaId: string,
): Promise<ActionResult<{ id: string }>> {
  const result = await run(async () => {
    const http = await adminHttp();
    await api.removeProductMedia(http, productId, mediaId);
    return { id: productId };
  });

  if (result.ok) {
    revalidatePath(`/admin/products/${productId}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Catalogue display order
// ---------------------------------------------------------------------------

export async function reorderProductsAction(
  productIds: readonly string[],
): Promise<ActionResult<{ reordered: number }>> {
  const result = await run(async () => {
    const http = await adminHttp();
    return api.reorderProducts(http, productIds);
  });

  if (result.ok) {
    // Every "manual"-sorted page (today, just `/products`) is now stale, and
    // the list this screen itself reads is cursor-paginated by `sortOrder`.
    revalidatePath("/admin/products");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * `/admin/products` IS ALSO REVALIDATED ON EVERY CATEGORY WRITE. The product
 * list's own view and the product editor's category picker both read the
 * category tree, and a rename or a delete changing what that picker offers is
 * exactly the kind of "stale until someone reloads twice" bug a missed
 * revalidation produces. Categories are tens of rows edited rarely, so the
 * extra invalidation costs nothing an operator would notice.
 */
function revalidateCategorySurfaces(): void {
  revalidatePath("/admin/categories");
  revalidatePath("/admin/products");
}

export async function createCategoryAction(
  input: api.CreateCategoryInput,
): Promise<ActionResult<Awaited<ReturnType<typeof api.createCategory>>>> {
  const result = await run(async () => {
    const http = await adminHttp();
    return api.createCategory(http, input);
  });

  if (result.ok) {
    revalidateCategorySurfaces();
  }
  return result;
}

export async function updateCategoryAction(
  id: string,
  input: api.UpdateCategoryInput,
): Promise<ActionResult<Awaited<ReturnType<typeof api.updateCategory>>>> {
  const result = await run(async () => {
    const http = await adminHttp();
    return api.updateCategory(http, id, input);
  });

  if (result.ok) {
    revalidateCategorySurfaces();
  }
  return result;
}

export async function reorderCategoriesAction(
  categoryIds: readonly string[],
): Promise<ActionResult<{ reordered: number }>> {
  const result = await run(async () => {
    const http = await adminHttp();
    return api.reorderCategories(http, categoryIds);
  });

  if (result.ok) {
    revalidateCategorySurfaces();
  }
  return result;
}

export async function deleteCategoryAction(id: string): Promise<ActionResult<null>> {
  const result = await run(async () => {
    const http = await adminHttp();
    await api.deleteCategory(http, id);
    return null;
  });

  if (result.ok) {
    revalidateCategorySurfaces();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Site settings
// ---------------------------------------------------------------------------

/**
 * `/admin/settings` IS NOT REVALIDATED — this page always reads a fresh
 * `GET /site-settings` on load (a `force-dynamic`-equivalent server
 * component, not cached), so there is no stale Next.js Data Cache entry for
 * this action to purge. The storefront's own copy of the flag lives in
 * `apps/storefront/src/lib/maintenance.ts`'s in-memory poll cache, which
 * this action does not — and structurally cannot — reach directly; it
 * catches up within that module's own TTL.
 */
export async function updateSiteSettingsAction(
  input: UpdateSiteSettings,
): Promise<ActionResult<Awaited<ReturnType<typeof api.updateSiteSettings>>>> {
  return run(async () => {
    const http = await adminHttp();
    return api.updateSiteSettings(http, input);
  });
}

// ---------------------------------------------------------------------------
// Blog — spec 2026-09-24 §8
// ---------------------------------------------------------------------------

function revalidateBlogSurfaces(id?: string): void {
  revalidatePath("/admin/blog");
  if (id !== undefined) revalidatePath(`/admin/blog/${id}`);
}

export async function createBlogPostAction(
  input: CreateBlogPost,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const body = createBlogPostSchema.parse(input);
    const http = await adminHttp();
    const post = await api.createBlogPost(http, body);
    revalidateBlogSurfaces();
    return { id: post.id };
  });
}

export async function updateBlogPostAction(
  id: string,
  input: UpdateBlogPost,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const body = updateBlogPostSchema.parse(input);
    const http = await adminHttp();
    const post = await api.updateBlogPost(http, id, body);
    revalidateBlogSurfaces(id);
    return { id: post.id };
  });
}

export async function setBlogPostPublishedAction(
  id: string,
  published: boolean,
): Promise<ActionResult<{ status: BlogPostStatus }>> {
  return run(async () => {
    const http = await adminHttp();
    const post = await api.setBlogPostPublished(http, id, published);
    revalidateBlogSurfaces(id);
    return { status: post.status };
  });
}

export async function deleteBlogPostAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const http = await adminHttp();
    await api.deleteBlogPost(http, id);
    revalidateBlogSurfaces(id);
    return null;
  });
}

/** A signed PUT for the cover — see `createMediaUploadUrlAction` for why this is an action. */
export async function createBlogCoverUploadUrlAction(
  id: string,
  input: BlogCoverUploadUrlRequest,
): Promise<ActionResult<Awaited<ReturnType<typeof api.createBlogCoverUploadUrl>>>> {
  return run(async () => {
    const body = blogCoverUploadUrlRequestSchema.parse(input);
    const http = await adminHttp();
    return api.createBlogCoverUploadUrl(http, id, body);
  });
}

/**
 * Machine-translate a post's copy into the other locale — the blog twin of
 * `translateProductCopyAction`, with the same guarantees: it PREFILLS and never
 * saves, blank fields are never sent, and the contract's ceilings are applied
 * before the metered vendor is addressed.
 */
export async function translateBlogCopyAction(input: unknown): Promise<ActionResult<BlogCopy>> {
  const parsed = translateBlogCopyInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: null,
      message: "The translation request was rejected before it was sent.",
    };
  }

  const texts = toBlogTranslationTexts(parsed.data.copy);
  if (texts.length === 0) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: "EMPTY_SOURCE",
      message: "There is nothing to translate.",
    };
  }

  const body = translateRequestSchema.safeParse({
    source: parsed.data.from,
    target: parsed.data.to,
    texts,
  });
  if (!body.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: null,
      message: "The copy is outside the bounds the translation endpoint accepts.",
    };
  }

  return run(async () => {
    const http = await adminHttp();
    const response = await api.translateCopy(http, body.data);
    return mergeBlogTranslations(response.translations);
  });
}

// ---------------------------------------------------------------------------
// Shipping zones and rates — Sendcloud spec §7a (decision D8)
// ---------------------------------------------------------------------------

/**
 * Nothing on the storefront is revalidated: the quote and the free-shipping
 * threshold read the rate rows live on every request (spec §7a, "revalidation
 * of nothing"). Only this screen's own server render is refreshed.
 *
 * Every argument is re-parsed — ids with `idSchema`, bodies inside
 * `shippingApi` with the SAME `.strict()` schema the API applies — because a
 * server action is a public endpoint whatever its one caller passes.
 */
function revalidateShippingSurface(): void {
  revalidatePath("/admin/shipping");
}

export async function createShippingZoneAction(
  input: shippingApi.CreateShippingZoneInput,
): Promise<ActionResult<AdminShippingZoneDetail>> {
  return run(async () => {
    const http = await adminHttp();
    const zone = await shippingApi.createShippingZone(http, input);
    revalidateShippingSurface();
    return zone;
  });
}

export async function updateShippingZoneAction(
  zoneId: string,
  input: shippingApi.UpdateShippingZoneInput,
): Promise<ActionResult<AdminShippingZoneDetail>> {
  return run(async () => {
    const id = idSchema.parse(zoneId);
    const http = await adminHttp();
    const zone = await shippingApi.updateShippingZone(http, id, input);
    revalidateShippingSurface();
    return zone;
  });
}

/** Soft delete, rates included. Existing orders keep their shipping snapshot. */
export async function deleteShippingZoneAction(zoneId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const id = idSchema.parse(zoneId);
    const http = await adminHttp();
    await shippingApi.deleteShippingZone(http, id);
    revalidateShippingSurface();
    return null;
  });
}

export async function createShippingRateAction(
  zoneId: string,
  input: shippingApi.CreateShippingRateInput,
): Promise<ActionResult<AdminShippingRate>> {
  return run(async () => {
    const id = idSchema.parse(zoneId);
    const http = await adminHttp();
    const rate = await shippingApi.createShippingRate(http, id, input);
    revalidateShippingSurface();
    return rate;
  });
}

/** Also deactivation: `{ isActive: false }`. */
export async function updateShippingRateAction(
  zoneId: string,
  rateId: string,
  input: shippingApi.UpdateShippingRateInput,
): Promise<ActionResult<AdminShippingRate>> {
  return run(async () => {
    const zone = idSchema.parse(zoneId);
    const rate = idSchema.parse(rateId);
    const http = await adminHttp();
    const updated = await shippingApi.updateShippingRate(http, zone, rate, input);
    revalidateShippingSurface();
    return updated;
  });
}

export async function deleteShippingRateAction(
  zoneId: string,
  rateId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const zone = idSchema.parse(zoneId);
    const rate = idSchema.parse(rateId);
    const http = await adminHttp();
    await shippingApi.deleteShippingRate(http, zone, rate);
    revalidateShippingSurface();
    return null;
  });
}

// ---------------------------------------------------------------------------
// Shipments — recorded by hand (carrier and tracking number as free text)
// ---------------------------------------------------------------------------

/**
 * "Marcar como enviado": record a parcel for the given lines. The API refuses
 * shipping more units than remain, so two operators on one order cannot
 * double-ship it, and walks the order PAID → FULFILLING → SHIPPED.
 */
export async function createShipmentAction(
  orderNumber: string,
  input: CreateShipment,
): Promise<ActionResult<{ shipmentId: string }>> {
  return run(async () => {
    const body = createShipmentSchema.parse(input);
    const http = await adminHttp();
    const shipment = await api.createShipment(http, orderNumber, body);
    revalidatePath("/admin/orders");
    revalidatePath(`/admin/orders/${orderNumber}`);
    return { shipmentId: shipment.id };
  });
}

/** Mark one parcel delivered; the API completes the order once every parcel is. */
export async function markShipmentDeliveredAction(
  shipmentId: string,
  orderNumber: string,
): Promise<ActionResult<{ status: ShipmentStatus }>> {
  return run(async () => {
    const id = idSchema.parse(shipmentId);
    const http = await adminHttp();
    const shipment = await api.markShipmentDelivered(http, id);
    revalidatePath("/admin/orders");
    revalidatePath(`/admin/orders/${orderNumber}`);
    return { status: shipment.status };
  });
}
