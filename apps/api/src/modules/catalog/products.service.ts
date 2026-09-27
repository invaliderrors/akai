import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@akai/db";
import type { ServerEnv } from "@akai/config";
import {
  computeStackDiscountTiers,
  REVALIDATE_TAG_CATEGORIES,
  REVALIDATE_TAG_PRODUCTS,
  type Category,
  type CreateProduct,
  type CreateVariant,
  type Locale,
  type OfferEverywhere,
  type OfferEverywhereResult,
  type Paginated,
  type Product,
  type ProductAddOnInput,
  type ProductKind,
  type ProductListQuery,
  type ProductTranslation,
  type ProductVariant,
  type PublicPackComponent,
  type PublicProduct,
  type TaxClass,
  type UpdateProduct,
} from "@akai/contracts";
import { splitGross, toMinor } from "@akai/money";
import { sanitizeRichText } from "@akai/rich-text";
import { PrismaService } from "../prisma/prisma.service";
import { SERVER_CONFIG } from "../config/config.module";
import { CLOCK, type Clock } from "../auth/ports/clock.port";
import { presignGetUrl, presignPutUrl } from "../media/s3-presigner";
import type {
  AttachCoa,
  CoaUploadUrlResponse,
  CreateCoaUploadUrl,
} from "../batches/batches.dto";
import { CatalogError } from "./catalog.errors";
import { CATALOG_TOPICS, type CatalogTopic } from "./catalog.events";
import {
  derivePackAvailability,
  mapProduct,
  mapVariant,
  productInclude,
  toPublicProduct,
  type HydratedProduct,
} from "./product.mapper";
import { buildProductPageQuery, type ProductSort } from "./product-query";
import { REVALIDATION_TOPIC } from "../revalidation/revalidation.types";
import { TaxRateResolver } from "./tax-rate.resolver";
import { mapCategoryEntity } from "../categories/category.mapper";
import type {
  AddMedia,
  AdminProductListQuery,
  CreateCategory,
  PublicAddOnListQuery,
  ReorderCategories,
  ReorderProducts,
  SetAddOns,
  SetCategories,
  SetRestrictions,
  UpdateCategory,
  UpdateVariant,
} from "./dto/catalog.dto";

/** Raw id rows from the pagination query. Validated, never cast. */
const idRowsSchema = z.array(z.object({ id: z.string().uuid() }));

/**
 * The most add-ons one product page may offer.
 *
 * Mirrors the cap `setAddOnsSchema` and `createProductSchema` already enforce.
 * It matters here because `offerEverywhere` writes to hosts it never validated
 * a body for: a host already holding twenty is skipped and counted, rather than
 * pushed over a limit the dedicated route would have refused.
 */
const ADD_ON_MAX = 20;

/**
 * The outcome of a write that stored product COPY.
 *
 * `product` is what the caller gets back. `sanitizedLocales` is the honest part:
 * descriptions are rewritten on the way into the column, and a write that
 * changed the operator's input without saying so is a silent edit of somebody
 * else's words. The controller turns a non-empty list into a response header
 * (see `CONTENT_SANITIZED_HEADER`, which carries the full reasoning) rather than
 * into a body field, so the resource representation stays exactly the `Product`
 * every existing admin client already parses.
 *
 * Only `create` and `update` return this. `setPublished`, `restore`, `addMedia`
 * and the rest write no translations, so there is nothing they could report and
 * no reason to make every caller unwrap a result that is always empty.
 */
export interface ProductWriteResult {
  readonly product: Product;
  /** Locales whose `description` the sanitiser altered. Empty when it did not. */
  readonly sanitizedLocales: readonly Locale[];
}

/** A translation ready for the column, paired with whether storing it changed it. */
interface SanitizedTranslations {
  readonly stored: readonly ProductTranslation[];
  readonly sanitizedLocales: readonly Locale[];
}

/**
 * Products and variants: reads, writes, lifecycle.
 *
 * THE PAYMENT GATEWAY IS NEVER CALLED FROM HERE. Every mutation that a downstream replica
 * needs to know about writes an outbox row inside the SAME transaction as the
 * change (spec §9). See catalog.events.ts for why that is not merely tidier.
 */
/**
 * How long a signed COA read URL on an ADMIN read is good for — the product's
 * own `coaUrl` and a batch's. An hour suits an admin form left open.
 *
 * The PUBLIC product shape never carries a signed URL — only `hasCoa` —
 * because a URL baked into ISR-cached HTML went dead when it expired. Shoppers
 * reach the PDF through `GET /v1/products/:slug/coa`, signed at click time
 * with `COA_REDIRECT_TTL_SECONDS`.
 */
const COA_URL_TTL_SECONDS = 3600;

/**
 * The TTL of the URL `GET /v1/products/:slug/coa` redirects to. Short: it is
 * signed at click time and followed immediately, so it never sits in a cached
 * page — which is the whole point of that route.
 */
const COA_REDIRECT_TTL_SECONDS = 300;

/**
 * The TTL of a product certificate UPLOAD url. Mirrors `BatchesService` and
 * `MediaService`: long enough for a slow connection, short enough that a
 * captured URL is worthless soon after.
 */
const COA_UPLOAD_URL_TTL_SECONDS = 600;

/**
 * What may follow `coa/products/{productId}/` in a key `attachCoa` accepts:
 * exactly the shape `buildProductCoaKey` issues — one path segment, no
 * separators, no dots but the extension's. A bare prefix check would accept
 * `coa/products/{mine}/../{theirs}/x.pdf`.
 */
const PRODUCT_COA_KEY_TAIL = /^[0-9A-Za-z-]+\.pdf$/;

const S3_REGION = "us-east-1";

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxRates: TaxRateResolver,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * A signed, time-boxed URL to read one COA PDF from the PRIVATE bucket.
   *
   * The only place `product.mapper.ts`'s `coaUrl` ever gets a real value —
   * every mapper call in this service passes this in, so a public read and an
   * admin read see the identical signing logic, not two that could drift.
   */
  private signCoaUrl = (
    objectKey: string,
    expiresInSeconds: number = COA_URL_TTL_SECONDS,
  ): string =>
    presignGetUrl({
      endpoint: this.config.S3_ENDPOINT,
      bucket: this.config.S3_BUCKET_COA,
      objectKey,
      region: S3_REGION,
      accessKeyId: this.config.S3_ACCESS_KEY_ID,
      secretAccessKey: this.config.S3_SECRET_ACCESS_KEY,
      expiresInSeconds,
      now: this.clock.now(),
    });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Public catalog listing.
   *
   * The audience restrictions are structural, not conditional: status is pinned
   * to ACTIVE, deleted rows are excluded, and a product with no purchasable
   * variant is filtered out. None of those are parameters the caller can
   * influence, because the public query schema has no fields that reach them.
   */
  async listPublic(
    query: ProductListQuery,
    locale: Locale,
  ): Promise<Paginated<PublicProduct>> {
    const page = await this.list(
      {
        status: "ACTIVE",
        // THE ONE SEAM for the listed/add-on split, and it stays one seam: this
        // method is the only path the public grid takes, and `query` has no
        // member that could override the value. An add-on is excluded from
        // /products and from nowhere else — `getBySlugPublic` still serves it,
        // because being unlisted means "not merchandised", not "hidden".
        listed: true,
        kind: query.kind,
        categorySlug: query.category,
        search: query.search,
        includeDeleted: false,
        requirePurchasableVariant: true,
        sort: query.sort,
        cursor: query.cursor,
        limit: query.limit,
        locale,
      },
      { activeVariantsOnly: true },
    );

    // The narrowing happens HERE, at the one method the public controller calls,
    // rather than inside `list` (which admin reads share and which must keep the
    // full inventory record).
    return {
      items: page.items.map((row) => this.toPublic(row)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /**
   * The public ADD-ON listing: products deliberately kept off /products.
   *
   * A SEPARATE METHOD BEHIND A SEPARATE ROUTE, not a parameter on `listPublic`.
   * The public list query is `.strict()` and declares no field that reaches the
   * visibility filter, which is exactly why a customer cannot ask for drafts;
   * spending that property on a `?listed=false` convenience would be trading a
   * structural guarantee for a saved method. Worse, a parameter means the
   * ENDPOINT'S MEANING IS SET BY THE CALLER: the day `listed = false` covers
   * more than add-ons — a staged launch, a wholesale-only SKU, a bundle kept
   * alive only for old links — `?listed=false` starts returning those too, with
   * no code change, no review and no test failing.
   *
   * THIS IS THE ONLY PUBLIC READER OF `listed = false` in the platform. If that
   * flag ever splits into more than one concept, this method is the single
   * place that must gain a second predicate, and a reader who greps for the
   * column finds it immediately.
   *
   * Everything else is pinned exactly as the main listing pins it: ACTIVE only,
   * not deleted, at least one purchasable variant, narrowed to `PublicProduct`.
   * An add-on is an ordinary product in every respect but where it is
   * merchandised, so it gets the ordinary protections.
   */
  async listPublicAddOns(
    query: PublicAddOnListQuery,
    locale: Locale,
  ): Promise<Paginated<PublicProduct>> {
    const page = await this.list(
      {
        status: "ACTIVE",
        listed: false,
        categorySlug: undefined,
        search: undefined,
        includeDeleted: false,
        requirePurchasableVariant: true,
        // Fixed server-side. Add-ons render as a short strip whose order should
        // not shuffle under the customer between two page loads, and "newest"
        // would do exactly that every time an add-on is edited.
        sort: "name",
        cursor: query.cursor,
        limit: query.limit,
        locale,
      },
      { activeVariantsOnly: true },
    );

    return {
      items: page.items.map((row) => this.toPublic(row)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /**
   * THE one row-to-public-shape step: map, narrow, and — for a PACK — publish
   * the component-derived stock instead of the pack variant's own row (see
   * `derivePackAvailability`).
   */
  private toPublic(row: HydratedProduct): PublicProduct {
    return toPublicProduct(
      mapProduct(row, { activeVariantsOnly: true }, this.signCoaUrl),
      derivePackAvailability(row),
    );
  }

  /** Admin listing: drafts and soft-deleted rows are reachable. */
  async listAdmin(
    query: AdminProductListQuery,
    locale: Locale,
  ): Promise<Paginated<Product>> {
    const page = await this.list(
      {
        status: query.status,
        kind: query.kind,
        // Undefined, not `true`: an admin managing add-ons must be able to SEE
        // them in the catalogue list, which is the only surface from which the
        // flag can be flipped back.
        listed: undefined,
        categorySlug: query.category,
        search: query.search,
        includeDeleted: query.includeDeleted,
        requirePurchasableVariant: false,
        sort: query.sort,
        cursor: query.cursor,
        limit: query.limit,
        locale,
      },
      { activeVariantsOnly: false },
    );
    return {
      items: page.items.map((row) =>
        mapProduct(row, { activeVariantsOnly: false }, this.signCoaUrl),
      ),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  private async list(
    options: {
      status: Product["status"] | undefined;
      kind?: Product["kind"] | undefined;
      listed: boolean | undefined;
      categorySlug: string | undefined;
      search: string | undefined;
      includeDeleted: boolean;
      requirePurchasableVariant: boolean;
      sort: ProductSort;
      cursor: string | undefined;
      limit: number;
      locale: Locale;
    },
    mapping: { activeVariantsOnly: boolean },
  ): Promise<Paginated<HydratedProduct>> {
    // limit+1: fetching one extra row is how `hasMore` is known without a second
    // COUNT query, which on a filtered catalog costs as much as the page itself.
    const sql = buildProductPageQuery({
      status: options.status,
      kind: options.kind,
      listed: options.listed,
      categorySlug: options.categorySlug,
      search: options.search,
      includeDeleted: options.includeDeleted,
      requirePurchasableVariant: options.requirePurchasableVariant,
      sort: options.sort,
      locale: options.locale,
      cursor: options.cursor,
      take: options.limit + 1,
    });

    const raw: unknown = await this.prisma.$queryRaw(sql);
    const rows = idRowsSchema.parse(raw);

    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const ids = pageRows.map((row) => row.id);

    if (ids.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      include: productInclude,
    });

    // `IN (...)` does not preserve order, so the SQL ordering is re-applied here.
    // Skipping this step is a silent bug: the page contains the right products
    // in the wrong sequence, which looks like a broken sort, not a broken join.
    const byId = new Map(products.map((product) => [product.id, product]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((product): product is HydratedProduct => product !== undefined)
      // A product whose every variant is hidden from this audience cannot
      // satisfy the contract's non-empty `variants`, so it is dropped rather
      // than serialised into an invalid shape.
      .filter(
        (product) =>
          !mapping.activeVariantsOnly ||
          product.variants.some((variant) => variant.isActive),
      );

    const lastRow = pageRows[pageRows.length - 1];

    return {
      // HYDRATED ROWS, mapped by each caller: the public projection needs the
      // row itself (a pack's availability is derived from its components'
      // inventory, which the wide `Product` shape does not carry).
      items: ordered,
      nextCursor: hasMore && lastRow !== undefined ? lastRow.id : null,
      hasMore,
    };
  }

  /**
   * Public product detail by slug.
   *
   * Falls back to `product_slug_history`, so a renamed product keeps resolving
   * at its old URL instead of 404ing every inbound link, search result and
   * shared post that predates the rename.
   */
  /**
   * The add-ons THIS product's page offers, in the operator's order.
   *
   * REUSES `getBySlugPublic`, and that is the point: slug-history resolution
   * lives and is tested there, so a renamed product's strip survives the rename
   * without a second copy of that logic. The refs it returns are already ordered
   * by the edge's `sortOrder`.
   *
   * NO KEYSET, DELIBERATELY. `setAddOnsSchema` caps a page's add-ons at 20, so
   * the whole set fits in one response and there is nothing to paginate.
   * Ordering by the edge through the shared query builder would instead need a
   * new sort plan whose keyset predicate matched its direction exactly, and a
   * mismatch there does not fail — it silently repeats a page.
   *
   * A REF THAT RESOLVES TO NOTHING SHORTENS THE STRIP rather than failing it.
   * `status` changes without anyone touching the edge, so an add-on that was
   * archived should stop being offered, not 500 the page that offers it.
   */
  async listAddOnsFor(slug: string): Promise<Paginated<PublicProduct>> {
    const host = await this.getBySlugPublic(slug);

    if (host.addOns.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const rows = await this.prisma.product.findMany({
      where: {
        id: { in: host.addOns.map((ref) => ref.id) },
        deletedAt: null,
        status: "ACTIVE",
      },
      include: productInclude,
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: PublicProduct[] = [];

    for (const ref of host.addOns) {
      const row = byId.get(ref.id);
      if (row === undefined || !row.variants.some((variant) => variant.isActive)) {
        continue;
      }
      items.push(this.toPublic(row));
    }

    return { items, nextCursor: null, hasMore: false };
  }

  /**
   * The products THIS pack is made of, resolved from `packComponents`' thin
   * refs — same shape and same reasoning as `listAddOnsFor` immediately
   * above, and it exists for the identical reason: `productSchema` cannot
   * embed the components' own full shape without becoming recursive, so the
   * storefront PDP makes one extra call, and only for a product that is
   * actually a pack.
   *
   * DISPLAY ONLY — "has an active variant" gates what appears here, not
   * whether the pack is currently sellable. The real per-component
   * purchasability check (the pinned variant specifically, not just any
   * variant of the product) lives where it has to: `CartService.addPack()`,
   * at add-to-cart time.
   */
  async listPackComponentsFor(slug: string): Promise<Paginated<PublicPackComponent>> {
    const host = await this.getBySlugPublic(slug);

    if (host.packComponents.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const rows = await this.prisma.product.findMany({
      where: {
        id: { in: host.packComponents.map((ref) => ref.id) },
        deletedAt: null,
        status: "ACTIVE",
      },
      include: productInclude,
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: PublicPackComponent[] = [];

    for (const ref of host.packComponents) {
      const row = byId.get(ref.id);
      if (row === undefined || !row.variants.some((variant) => variant.isActive)) {
        continue;
      }
      items.push({
        product: this.toPublic(row),
        // WHICH variant is pinned, and how many — the storefront must price
        // and label this row from THAT variant specifically, never from
        // `product.variants`' own cheapest-first default.
        variantId: ref.variantId,
        quantity: ref.quantity,
        sortOrder: ref.sortOrder,
      });
    }

    return { items, nextCursor: null, hasMore: false };
  }

  async getBySlugPublic(slug: string): Promise<PublicProduct> {
    const direct = await this.prisma.product.findFirst({
      where: { slug, deletedAt: null, status: "ACTIVE" },
      include: productInclude,
    });

    const product = direct ?? (await this.resolveHistoricSlug(slug));

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    if (!product.variants.some((variant) => variant.isActive)) {
      // Nothing purchasable behind it. 404 rather than an empty detail page.
      throw CatalogError.notFound("Product");
    }

    return this.toPublic(product);
  }

  /**
   * A FRESH signed URL for the product's certificate of analysis — the target
   * of the stable `GET /v1/products/:slug/coa` redirect.
   *
   * WHY A REDIRECT AND NOT A URL IN THE PAGE. The product page is ISR-cached,
   * and a signed URL embedded in it becomes a dead link for anyone who
   * arrives after the signature expires. Signing at click time makes the link
   * in the page permanent and the signature always fresh.
   *
   * THE SAME AUDIENCE RULES AS THE PRODUCT PAGE: ACTIVE, non-deleted
   * products, current or historic slug. And the SAME RULE AS `hasCoa`: a file
   * must be uploaded AND the admin's `showCoa` switch on. An uploaded but
   * hidden certificate 404s exactly like a missing one — "hidden" must not be
   * defeated by someone who guesses the URL, and the answer must not reveal
   * that a hidden file exists.
   */
  async coaUrlFor(slug: string): Promise<string> {
    return this.signCoaUrl(await this.coaObjectKeyFor(slug), COA_REDIRECT_TTL_SECONDS);
  }

  /**
   * The private-bucket key of the product's certificate, under EXACTLY the
   * rules `coaUrlFor` states above — it is the one place those rules live.
   * `coaUrlFor` signs the key for the redirect; `GET /v1/products/:slug/coa/file`
   * reads the bytes server-side for the in-page viewer. Two routes, one
   * visibility decision, so "hidden" cannot be hidden on one and served on the
   * other.
   */
  async coaObjectKeyFor(slug: string): Promise<string> {
    const select = { id: true, coaObjectKey: true, showCoa: true } as const;
    const product =
      (await this.prisma.product.findFirst({
        where: { slug, deletedAt: null, status: "ACTIVE" },
        select,
      })) ?? (await this.resolveHistoricCoaRow(slug));

    if (product === null || !product.showCoa || product.coaObjectKey === null) {
      throw CatalogError.notFound("Certificate of analysis");
    }

    return product.coaObjectKey;
  }

  private async resolveHistoricCoaRow(
    slug: string,
  ): Promise<{ id: string; coaObjectKey: string | null; showCoa: boolean } | null> {
    const historic = await this.prisma.productSlugHistory.findUnique({
      where: { slug },
      select: { productId: true },
    });
    if (historic === null) {
      return null;
    }
    return this.prisma.product.findFirst({
      where: { id: historic.productId, deletedAt: null, status: "ACTIVE" },
      select: { id: true, coaObjectKey: true, showCoa: true },
    });
  }

  // -------------------------------------------------------------------------
  // The product's certificate of analysis (admin)
  // -------------------------------------------------------------------------
  //
  // ONE CERTIFICATE PER PRODUCT, uploaded with the same two-step presign →
  // PUT → confirm pattern `BatchesService` uses for a lot's certificate, into
  // the same PRIVATE bucket (`S3_BUCKET_COA`): PDF only, ≤ 10 MB (the shared
  // `createCoaUploadUrlSchema`), and the bytes never transit the API. Keyed
  // `coa/products/{productId}/…`, a prefix no batch key can share (a batch key
  // is `coa/{batchId}/…`). Whether the shop OFFERS it is the separate
  // `showCoa` switch, saved with the product through `update()`.
  //
  // A replaced or removed file's object is left in the bucket, as media and
  // batch certificates are: private, unreferenced and harmless, and deleting
  // it inline would couple a catalog write to object storage being up.

  async createCoaUploadUrl(
    productId: string,
    input: CreateCoaUploadUrl,
  ): Promise<CoaUploadUrlResponse> {
    await this.assertProductExists(productId);

    // Already bounded at 10 MB by `createCoaUploadUrlSchema`; the signed PUT
    // does not carry a length, so there is nothing more to do with it here.
    void input.sizeBytes;

    const now = this.clock.now();
    const objectKey = buildProductCoaKey(productId, now);
    const uploadUrl = presignPutUrl({
      endpoint: this.config.S3_ENDPOINT,
      bucket: this.config.S3_BUCKET_COA,
      objectKey,
      region: S3_REGION,
      accessKeyId: this.config.S3_ACCESS_KEY_ID,
      secretAccessKey: this.config.S3_SECRET_ACCESS_KEY,
      expiresInSeconds: COA_UPLOAD_URL_TTL_SECONDS,
      now,
    });

    return { uploadUrl, objectKey, expiresInSeconds: COA_UPLOAD_URL_TTL_SECONDS };
  }

  /**
   * Record the key an upload succeeded to — first upload and replacement
   * alike. REFUSES a key this product was not issued: otherwise an admin
   * session could point one product's certificate at another's (or at a
   * batch's) object.
   */
  async attachCoa(productId: string, input: AttachCoa): Promise<Product> {
    const prefix = `coa/products/${productId}/`;
    if (
      !input.objectKey.startsWith(prefix) ||
      !PRODUCT_COA_KEY_TAIL.test(input.objectKey.slice(prefix.length))
    ) {
      throw CatalogError.validation(
        "This object key was not issued for this product — request a fresh upload URL",
      );
    }
    await this.assertProductExists(productId);

    await this.runWrite(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { coaObjectKey: input.objectKey },
      });
      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productCoaAttached);
    }, "Product");

    return this.getByIdAdmin(productId);
  }

  /** Forget the product's certificate. The page's button goes with it. */
  async removeCoa(productId: string): Promise<Product> {
    await this.assertProductExists(productId);

    await this.runWrite(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { coaObjectKey: null },
      });
      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productCoaRemoved);
    }, "Product");

    return this.getByIdAdmin(productId);
  }

  private async assertProductExists(productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (product === null) {
      throw CatalogError.notFound("Product");
    }
  }

  private async resolveHistoricSlug(slug: string): Promise<HydratedProduct | null> {
    const historic = await this.prisma.productSlugHistory.findUnique({
      where: { slug },
      select: { productId: true },
    });

    if (historic === null) {
      return null;
    }

    return this.prisma.product.findFirst({
      where: { id: historic.productId, deletedAt: null, status: "ACTIVE" },
      include: productInclude,
    });
  }

  /** Admin detail: drafts and soft-deleted rows included, all variants visible. */
  async getByIdAdmin(id: string): Promise<Product> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: productInclude,
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    return mapProduct(product, { activeVariantsOnly: false }, this.signCoaUrl);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(input: CreateProduct, actorId: string): Promise<ProductWriteResult> {
    this.assertUniqueSkus(input.variants.map((variant) => variant.sku));

    // BEFORE the transaction. The composite foreign key would catch a default
    // naming another product's variant, but as a constraint violation mapped to
    // a conflict; checked here it is a 400 that names what is wrong.
    const addOnInput = ProductsService.resolveAddOnInput(input);
    await this.assertDefaultVariantsBelong(addOnInput);

    // No existing row on create, so there is no self-reference to guard and no
    // "leave kind alone" case — `input.kind` alone decides.
    this.assertValidPackComponentInput(input.kind, undefined, input.packComponents);
    if (input.packComponents !== undefined) {
      await this.assertPackVariantsBelong(input.packComponents);
    }

    // Sanitised OUTSIDE the transaction: it is pure string work, and holding a
    // Postgres transaction open across a parse of up to 20,000 characters per
    // locale buys nothing and locks rows for longer.
    const { stored, sanitizedLocales } = this.sanitizeTranslations(input.translations);

    const priced = await Promise.all(
      input.variants.map(async (variant) => ({
        variant,
        taxRateBps: await this.taxRates.resolveBps(input.taxClass),
      })),
    );

    const created = await this.runWrite(async (tx) => {
      const product = await tx.product.create({
        data: {
          slug: input.slug,
          status: input.status,
          taxClass: input.taxClass,
          restrictedCountries: input.restrictedCountries,
          listed: input.listed,
          // EXPLICIT, not omitted when absent — `offerOnNewProducts` and
          // `newProductDefaultVariantId` are validated by `createProductSchema`
          // but never reach this object, so a product created with either set
          // silently keeps the column's own default until a later update. Do
          // not repeat that for this field: `?? false` means a stack-discount
          // choice made while CREATING a product is never silently dropped.
          stackDiscountEnabled: input.stackDiscountEnabled ?? false,
          // Same "explicit, never omitted when absent" reasoning the comment
          // above gives for stackDiscountEnabled: a kind chosen while creating
          // a product must not silently keep the column's own SIMPLE default
          // until a later update.
          kind: input.kind ?? "SIMPLE",
          // Same "explicit, never omitted" reasoning as `kind` above.
          form: input.form ?? "LYOPHILIZED",
          // Hidden unless the admin says otherwise: an upload alone must never
          // put a certificate in front of a shopper.
          showCoa: input.showCoa ?? false,
          translations: { create: [...stored] },
          categories: {
            create: input.categoryIds.map((categoryId, index) => ({
              categoryId,
              sortOrder: index,
            })),
          },
          // Nested-created with the product, exactly as categories/addOns
          // above are. Self-reference is not possible here — the product has
          // no id yet — a component id naming no product fails on the foreign
          // key the same way a bad categoryId already does on this path.
          ...(input.packComponents === undefined
            ? {}
            : {
                packComponents: {
                  create: input.packComponents.map((entry, index) => ({
                    componentProductId: entry.id,
                    componentVariantId: entry.variantId,
                    sortOrder: index,
                    quantity: entry.quantity,
                  })),
                },
              }),
          // Nested-created with the product, exactly as the categories above
          // are, so an operator who chose add-ons while building a product does
          // not have to save, reopen and choose again. Self-reference is not
          // possible here — the product has no id yet — and an id naming no
          // product fails on the foreign key, the same way a bad categoryId
          // already does on this path.
          addOns: {
            create: addOnInput.map((entry, index) => ({
              addOnId: entry.id,
              sortOrder: index,
              defaultVariantId: entry.defaultVariantId,
            })),
          },
        },
        select: { id: true, slug: true },
      });

      await this.attachStickyAddOns(tx, product.id, addOnInput);

      for (const { variant, taxRateBps } of priced) {
        await this.insertVariant(
          tx,
          product.id,
          variant,
          taxRateBps,
          actorId,
          input.stackDiscountEnabled ?? false,
        );
      }

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productCreated);

      return product.id;
    }, "Product");

    return { product: await this.getByIdAdmin(created), sanitizedLocales };
  }

  async update(id: string, input: UpdateProduct): Promise<ProductWriteResult> {
    const existing = await this.prisma.product.findUnique({
      where: { id },
      select: { id: true, slug: true, deletedAt: true, kind: true },
    });

    if (existing === null) {
      throw CatalogError.notFound("Product");
    }

    // UNLIKE CREATE, an update CAN name the product itself — it has an id now.
    // The table's CHECK would catch it, but as a constraint violation mapped to
    // a conflict; named here it is a 400 an operator can read, matching what
    // `setAddOns` already answers on the dedicated route.
    // EITHER FIELD MEANS "the caller is changing add-ons". `addOnIds` is the
    // shape the previous dashboard build sends and is accepted for one release;
    // `addOns` is the same choice plus a default variant per add-on.
    const addOnsTouched = input.addOns !== undefined || input.addOnIds !== undefined;
    const addOnInput = addOnsTouched ? ProductsService.resolveAddOnInput(input) : [];

    if (addOnsTouched && addOnInput.some((entry) => entry.id === id)) {
      throw CatalogError.validation("A product cannot offer itself as an add-on");
    }

    if (addOnsTouched) {
      await this.assertDefaultVariantsBelong(addOnInput);
    }

    this.assertValidPackComponentInput(input.kind, existing.kind, input.packComponents, id);
    if (input.packComponents !== undefined) {
      await this.assertPackVariantsBelong(input.packComponents);
    }
    // TURNING KIND AWAY FROM PACK CLEARS THE COMPONENT LIST even when the
    // caller did not separately touch `packComponents` — a SIMPLE product
    // carrying stale `ProductPackComponent` rows would still show them in its
    // API response (the mapper reads the table unconditionally), which is a
    // lie about what the product now is. Matches `assertValidPackComponentInput`
    // refusing the opposite: a non-PACK product may never gain components.
    const packComponentsTouched =
      input.packComponents !== undefined || (input.kind !== undefined && input.kind !== "PACK");
    const packComponentsToWrite =
      input.kind !== undefined && input.kind !== "PACK" ? [] : (input.packComponents ?? []);

    // The STICKY default names a variant of this product itself — it is the one
    // those automatic edges pre-select — so the same ownership check applies
    // with the product standing in as its own add-on. Update only: at create
    // time the variants do not exist yet, so there is no id to name.
    if (input.newProductDefaultVariantId != null) {
      await this.assertDefaultVariantsBelong([
        { id, defaultVariantId: input.newProductDefaultVariantId },
      ]);
    }

    const { stored, sanitizedLocales } =
      input.translations === undefined
        ? { stored: [], sanitizedLocales: [] }
        : this.sanitizeTranslations(input.translations);

    await this.runWrite(async (tx) => {
      // A slug change preserves the old value in history BEFORE the update, so
      // the unique index on `product.slug` is free the moment the new one lands.
      if (input.slug !== undefined && input.slug !== existing.slug) {
        await tx.productSlugHistory.upsert({
          where: { slug: existing.slug },
          create: { slug: existing.slug, productId: id },
          update: {},
        });
        // If the incoming slug was itself a historic slug of THIS product,
        // free it — otherwise the unique index rejects reusing a former name.
        await tx.productSlugHistory.deleteMany({
          where: { slug: input.slug, productId: id },
        });
      }

      await tx.product.update({
        where: { id },
        data: {
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.taxClass === undefined ? {} : { taxClass: input.taxClass }),
          ...(input.restrictedCountries === undefined
            ? {}
            : { restrictedCountries: input.restrictedCountries }),
          ...(input.listed === undefined ? {} : { listed: input.listed }),
          // WITHOUT THESE TWO THE UPDATE VALIDATES AND THEN DISCARDS. That is
          // exactly how `listed` used to be lost: the field reached the service,
          // passed every check, and never made it into `data`.
          ...(input.offerOnNewProducts === undefined
            ? {}
            : { offerOnNewProducts: input.offerOnNewProducts }),
          ...(input.newProductDefaultVariantId === undefined
            ? {}
            : { newProductDefaultVariantId: input.newProductDefaultVariantId }),
          ...(input.stackDiscountEnabled === undefined
            ? {}
            : { stackDiscountEnabled: input.stackDiscountEnabled }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.form === undefined ? {} : { form: input.form }),
          // Flipping it changes whether the page offers the certificate; the
          // `productUpdated` purge below covers it like any other field.
          ...(input.showCoa === undefined ? {} : { showCoa: input.showCoa }),
        },
      });

      // TURNING THE FLAG ON RECOMPUTES EVERY VARIANT'S TIERS FROM ITS OWN
      // CURRENT PRICE, because this is the one write path where the flag
      // changes with no per-variant call to hang the recompute off (unlike
      // `updateVariant`, which does its own recompute on every call once the
      // flag is already on). Runs on every save where the input carries `true`
      // — including a save where the flag was already true and nothing
      // pricing-related changed — which is harmless, idempotent, extra work
      // bounded by this product's own variant count (always single digits),
      // not worth gating behind a false→true transition for a first cut.
      //
      // TURNING IT OFF touches nothing here: existing tier rows are left
      // exactly as they are, now ordinary, freely-editable manual tiers.
      if (input.stackDiscountEnabled === true) {
        const variants = await tx.productVariant.findMany({
          where: { productId: id, deletedAt: null },
          select: { id: true, priceGross: true },
        });

        for (const variant of variants) {
          const tiers = computeStackDiscountTiers(toMinor(variant.priceGross));
          await tx.productVariantPriceTier.deleteMany({ where: { variantId: variant.id } });
          await tx.productVariantPriceTier.createMany({
            data: tiers.map((tier) => ({
              variantId: variant.id,
              minQuantity: tier.minQuantity,
              unitPriceGross: tier.unitPriceGross,
            })),
          });
        }
      }

      // `stored` is empty when the caller sent no translations at all, so the
      // loop simply does not run — the same "leave them alone" behaviour the
      // `undefined` check used to express, now expressed once, above.
      for (const translation of stored) {
        await tx.productTranslation.upsert({
          where: { productId_locale: { productId: id, locale: translation.locale } },
          create: { productId: id, ...translation },
          update: {
            name: translation.name,
            shortDescription: translation.shortDescription,
            description: translation.description,
          },
        });
      }

      if (input.categoryIds !== undefined) {
        await this.replaceCategories(tx, id, input.categoryIds);
      }

      if (addOnsTouched) {
        await this.replaceAddOns(tx, id, addOnInput);
      }

      if (packComponentsTouched) {
        await this.replacePackComponents(tx, id, packComponentsToWrite);
      }

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productUpdated);
    }, "Product");

    return { product: await this.getByIdAdmin(id), sanitizedLocales };
  }

  /**
   * Publish / unpublish.
   *
   * Publishing REQUIRES at least one active variant and at least one
   * translation. A published product with nothing to sell renders a detail page
   * with a dead buy button; the check belongs here rather than in the UI,
   * because the UI is not the only writer.
   */
  async setPublished(id: string, published: boolean): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        variants: { where: { deletedAt: null, isActive: true }, select: { id: true } },
        translations: { select: { id: true } },
      },
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    if (published) {
      if (product.variants.length === 0) {
        throw CatalogError.validation(
          "Cannot publish a product with no active variant — there would be nothing to buy",
        );
      }
      if (product.translations.length === 0) {
        throw CatalogError.validation("Cannot publish a product with no translations");
      }
    }

    await this.runWrite(async (tx) => {
      await tx.product.update({
        where: { id },
        data: { status: published ? "ACTIVE" : "DRAFT" },
      });

      await this.enqueueRevalidation(
        tx,
        published ? CATALOG_TOPICS.productPublished : CATALOG_TOPICS.productUnpublished,
      );
    }, "Product");

    return this.getByIdAdmin(id);
  }

  /**
   * Soft delete.
   *
   * Sets `deletedAt` and flips status to ARCHIVED; the row is never removed.
   * A hard delete would cascade into order lines and destroy financial history
   * — an invoice must still render years later, and it references this product.
   * Setting BOTH fields matters: `deletedAt` hides it from queries, ARCHIVED
   * makes the intent legible to anyone reading the row directly.
   */
  async softDelete(id: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, slug: true },
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    // A product still referenced as a live pack's component must not vanish
    // out from under it — same guard shape `removeCategory` already applies
    // to a category still assigned to a product. `onDelete: Restrict` on the
    // foreign key is defence in depth for a hard delete; this is what
    // actually fires, because soft delete is a plain UPDATE the FK cannot see.
    const packMemberships = await this.prisma.productPackComponent.count({
      where: { componentProductId: id, pack: { deletedAt: null } },
    });
    if (packMemberships > 0) {
      throw CatalogError.conflict(
        `Product is a component of ${packMemberships} pack(s); remove it from every pack first`,
      );
    }

    await this.runWrite(async (tx) => {
      const now = new Date();

      await tx.product.update({
        where: { id },
        data: { deletedAt: now, status: "ARCHIVED" },
      });

      // Variants are soft-deleted alongside so an orphaned variant cannot be
      // added to a cart by id after its product is gone.
      await tx.productVariant.updateMany({
        where: { productId: id, deletedAt: null },
        data: { deletedAt: now, isActive: false },
      });

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productArchived);
    }, "Product");
  }

  /** Restore returns the product as a DRAFT, never straight back to ACTIVE. */
  async restore(id: string): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { id: true, slug: true },
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    await this.runWrite(async (tx) => {
      await tx.product.update({
        where: { id },
        // DRAFT, not ACTIVE: restoring is an admin recovering a record, and
        // silently re-listing it to customers in the same step is a decision
        // they did not make.
        data: { deletedAt: null, status: "DRAFT" },
      });

      await tx.productVariant.updateMany({
        where: { productId: id },
        data: { deletedAt: null },
      });

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productRestored);
    }, "Product");

    return this.getByIdAdmin(id);
  }

  // -------------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------------

  async addVariant(
    productId: string,
    input: CreateVariant,
    actorId: string,
  ): Promise<ProductVariant> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, taxClass: true, stackDiscountEnabled: true },
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    const taxRateBps = await this.taxRates.resolveBps(product.taxClass);

    const variantId = await this.runWrite(
      async (tx) =>
        this.insertVariant(
          tx,
          productId,
          input,
          taxRateBps,
          actorId,
          product.stackDiscountEnabled,
        ),
      "Variant",
    );

    return this.readVariant(variantId);
  }

  /**
   * Update a variant under optimistic concurrency.
   *
   * The write is `updateMany({ where: { id, version } })` and a count of zero is
   * a rejection, not a retry. Two admins editing the same variant otherwise
   * last-write-wins, and the price change one of them made disappears with no
   * error shown to either.
   */
  async updateVariant(
    variantId: string,
    input: UpdateVariant,
    actorId: string,
  ): Promise<ProductVariant> {
    const existing = await this.prisma.productVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: {
        id: true,
        productId: true,
        sku: true,
        currency: true,
        priceGross: true,
        taxRateBps: true,
        version: true,
        product: { select: { stackDiscountEnabled: true } },
      },
    });

    if (existing === null) {
      throw CatalogError.notFound("Variant");
    }

    const taxRateBps = input.taxRateBps ?? existing.taxRateBps;
    const priceChanged =
      input.priceGross !== undefined && input.priceGross !== existing.priceGross;
    const rateChanged = taxRateBps !== existing.taxRateBps;

    // Net and tax are ALWAYS re-derived from gross rather than accepted or
    // partially updated. A caller changing only the tax rate must still get a
    // consistent triple, or the `priceNet + priceTax = priceGross` CHECK
    // constraint rejects the write at the database with an opaque error.
    const gross = toMinor(input.priceGross ?? existing.priceGross);
    const components = splitGross(gross, taxRateBps);

    await this.runWrite(async (tx) => {
      const result = await tx.productVariant.updateMany({
        where: { id: variantId, version: input.version, deletedAt: null },
        data: {
          ...(input.sku === undefined ? {} : { sku: input.sku }),
          ...(input.name === undefined ? {} : { name: jsonOrDbNull(input.name) }),
          ...(input.options === undefined ? {} : { options: toJsonObject(input.options) }),
          ...(input.weightGrams === undefined ? {} : { weightGrams: input.weightGrams }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          ...(input.compareAtGross === undefined
            ? {}
            : { compareAtGross: input.compareAtGross }),
          priceNet: components.net,
          priceTax: components.tax,
          priceGross: components.gross,
          taxRateBps,
          version: { increment: 1 },
        },
      });

      if (result.count === 0) {
        throw CatalogError.staleWrite("Variant");
      }

      // FULL REPLACEMENT, and only when asked: absent leaves the tiers alone,
      // an empty array clears them. `updateMany` cannot nest a relation write,
      // so this is explicit rather than part of the data literal above.
      //
      // AFTER THE STALE-WRITE GUARD, deliberately. A write that lost its version
      // race must change nothing at all; tiers replaced before that check would
      // outlive the update the check just rejected.
      //
      // WHEN THE PRODUCT'S FLAG IS ON, `input.priceTiers` IS IGNORED OUTRIGHT
      // and the schedule is recomputed from `gross` (this call's price, whether
      // or not price changed in THIS call) — the same trust boundary
      // `insertVariant` applies. This is what keeps a stack-discount variant's
      // tiers correct after a bare price edit with zero extra client logic: the
      // caller never has to remember to resend the schedule.
      const effectiveTiers = existing.product.stackDiscountEnabled
        ? computeStackDiscountTiers(components.gross)
        : input.priceTiers;

      if (effectiveTiers !== undefined) {
        await tx.productVariantPriceTier.deleteMany({ where: { variantId } });
        await tx.productVariantPriceTier.createMany({
          data: effectiveTiers.map((tier) => ({
            variantId,
            minQuantity: tier.minQuantity,
            unitPriceGross: tier.unitPriceGross,
          })),
        });
      }

      if (priceChanged || rateChanged) {
        await this.recordPriceChange(tx, variantId, {
          currency: existing.currency,
          net: components.net,
          tax: components.tax,
          gross: components.gross,
          taxRateBps,
          actorId,
        });

        await this.enqueueRevalidation(tx, CATALOG_TOPICS.variantPriceChanged);
      }

      if (input.isActive === false) {
        await this.enqueueRevalidation(tx, CATALOG_TOPICS.variantDeactivated);
      }

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.variantUpdated);
    }, "Variant");

    return this.readVariant(variantId);
  }

  /**
   * Soft-delete a variant.
   *
   * Refuses to remove the LAST active variant of a published product: the
   * contract requires a product to have at least one variant, and a live product
   * with none is unrenderable. Unpublish the product instead — which the error
   * says explicitly, because "cannot delete" without a remedy is a dead end.
   */
  async deleteVariant(variantId: string): Promise<void> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: {
        id: true,
        sku: true,
        productId: true,
        product: { select: { status: true } },
      },
    });

    if (variant === null) {
      throw CatalogError.notFound("Variant");
    }

    const siblings = await this.prisma.productVariant.count({
      where: {
        productId: variant.productId,
        deletedAt: null,
        isActive: true,
        id: { not: variantId },
      },
    });

    if (siblings === 0 && variant.product.status === "ACTIVE") {
      throw CatalogError.conflict(
        "Cannot remove the last active variant of a published product — unpublish it first",
      );
    }

    await this.runWrite(async (tx) => {
      await tx.productVariant.update({
        where: { id: variantId },
        data: { deletedAt: new Date(), isActive: false },
      });

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.variantDeactivated);
    }, "Variant");
  }

  private async readVariant(variantId: string): Promise<ProductVariant> {
    const product = await this.prisma.product.findFirst({
      where: { variants: { some: { id: variantId } } },
      include: productInclude,
    });

    const variant = product?.variants.find((candidate) => candidate.id === variantId);

    if (variant === undefined) {
      throw CatalogError.notFound("Variant");
    }

    return mapVariant(variant, this.signCoaUrl);
  }

  // -------------------------------------------------------------------------
  // Media, categories, restrictions
  // -------------------------------------------------------------------------

  /**
   * Record an uploaded asset against the product, or against ONE of its
   * variants when `variantId` is given.
   *
   * The two kinds are rows on the same table, told apart by `variantId`: NULL
   * for a gallery image, set for a variant image. `productInclude` partitions
   * them in the query, so a variant image never also shows up in the gallery.
   */
  async addMedia(productId: string, input: AddMedia): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, slug: true },
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    // The variant is looked up SCOPED TO THIS PRODUCT, and the caller-supplied
    // uuid is never written unverified. Same ownership discipline removeMedia
    // documents, in the other direction: without the `productId` clause an
    // admin holding product A's id could hang an asset off product B's variant
    // by guessing a uuid, and it would render on B's detail page.
    //
    // The failure is NOT_FOUND rather than a distinct "wrong product" code on
    // purpose — a caller who may not touch the variant learns nothing about
    // whether it exists, so the response cannot be used to enumerate uuids.
    if (input.variantId !== undefined) {
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: input.variantId, productId, deletedAt: null },
        select: { id: true },
      });

      if (variant === null) {
        throw CatalogError.notFound("Variant");
      }
    }

    const variantId = input.variantId ?? null;

    await this.runWrite(async (tx) => {
      // ATTACHING TO A VARIANT REPLACES, it does not append: `@@unique
      // ([variantId])` on media_asset caps a variant at one image, so a bare
      // create over an existing one raises P2002 and the operator would see a
      // uniqueness conflict instead of the image they just uploaded. Deleting
      // first inside the SAME transaction makes replacement atomic, where
      // "delete then attach" from the client races a concurrent write.
      //
      // Guarded by the null check rather than folded into the delete: a
      // `where: { variantId: null }` would match every gallery row and empty
      // the whole gallery.
      if (variantId !== null) {
        await tx.mediaAsset.deleteMany({ where: { variantId } });
      }

      await tx.mediaAsset.create({
        data: {
          productId,
          variantId,
          objectKey: input.objectKey,
          url: input.url,
          alt: toJsonObject(input.alt),
          width: input.width,
          height: input.height,
          sortOrder: input.sortOrder,
        },
      });

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productUpdated);
    }, "Media");

    return this.getByIdAdmin(productId);
  }

  async removeMedia(productId: string, mediaId: string): Promise<Product> {
    await this.runWrite(async (tx) => {
      // Scoped by BOTH ids: deleting by mediaId alone would let an admin holding
      // one product's id remove another product's asset by guessing. Same
      // ownership discipline as the customer-scoped repositories, applied to a
      // parent/child relationship. It scopes a VARIANT image correctly too —
      // `productId` stays NOT NULL on those rows precisely so this keeps working.
      const deleted = await tx.mediaAsset.deleteMany({
        where: { id: mediaId, productId },
      });

      if (deleted.count === 0) {
        // Thrown inside the transaction so the purge row rolls back with it:
        // announcing a change that did not happen is worse than not purging.
        throw CatalogError.notFound("Media");
      }

      // Dropping an image changes what the storefront renders — the hero falls
      // back to the product's primary the moment a variant image goes away —
      // so the purge belongs on the delete path as much as on the attach one.
      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productUpdated);
    }, "Media");

    return this.getByIdAdmin(productId);
  }

  async setCategories(productId: string, input: SetCategories): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    await this.runWrite(
      async (tx) => this.replaceCategories(tx, productId, input.categoryIds),
      "Category",
    );

    return this.getByIdAdmin(productId);
  }

  /**
   * Sets the catalogue-wide manual display order from the given id sequence —
   * a product's new `sortOrder` is its array index, the same "selection
   * order is the value" shape `replaceCategories`/`setAddOns` already use for
   * THEIR ordered lists (`add-on-picker.tsx`'s own doc comment names the same
   * convention client-side).
   *
   * SILENTLY DROPS AN ID THAT NO LONGER NAMES A LIVE PRODUCT, rather than
   * rejecting the whole batch. The admin's reorder screen loaded a real
   * snapshot of the catalogue; the only way an id in it stops being live
   * before the save lands is another operator soft-deleting that product in
   * the meantime — losing this operator's entire reorder over that race
   * would be worse than quietly reordering the rest.
   */
  async reorder(input: ReorderProducts): Promise<{ reordered: number }> {
    const live = await this.prisma.product.findMany({
      where: { id: { in: [...input.productIds] }, deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((row) => row.id));
    const ordered = input.productIds.filter((id) => liveIds.has(id));

    await this.runWrite(async (tx) => {
      for (const [index, id] of ordered.entries()) {
        await tx.product.update({ where: { id }, data: { sortOrder: index } });
      }
      // One event for the catalogue, same reasoning `offerEverywhere` gives:
      // every page a "manual"-sorted listing might render is now stale, and
      // there is no single product this write is "about".
      await this.enqueueRevalidation(tx, CATALOG_TOPICS.productUpdated);
    }, "Product");

    return { reordered: ordered.length };
  }

  // -------------------------------------------------------------------------
  // Category CRUD
  //
  // DELIBERATELY HERE, NOT IN `CategoriesService`. `CategoriesModule`'s own
  // doc comment reserves this: that module owns READING the category list as
  // navigation; a CRUD surface "belongs on the admin controller alongside the
  // [product/category] assignment route it must stay consistent with" —
  // `setCategories`/`replaceCategories` above, in this file. Splitting reads
  // and writes across two services would still be one entity with one set of
  // write rules, so nothing here is duplicated: `mapCategoryEntity` is the
  // categories module's own mapper, reused rather than re-implemented.
  // -------------------------------------------------------------------------

  /**
   * Create a category, appended to the end of the manual navigation order.
   *
   * `_max.sortOrder` is scoped to LIVE categories only — a soft-deleted
   * category's old position should not push a new one further down a list it
   * is not even part of.
   */
  async createCategory(input: CreateCategory): Promise<Category> {
    return this.runWrite(async (tx) => {
      const { _max } = await tx.category.aggregate({
        where: { deletedAt: null },
        _max: { sortOrder: true },
      });
      const sortOrder = (_max.sortOrder ?? -1) + 1;

      const created = await tx.category.create({
        data: { slug: input.slug, name: toJsonObject(input.name), sortOrder },
      });

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.categoryCreated);
      return mapCategoryEntity(created);
    }, "Category");
  }

  /**
   * Rename a category. `slug` and `sortOrder` are absent from the input on
   * purpose: `slug` is what the public `?category=` filter and every
   * bookmarked storefront link key on, and the storefront resolves it purely
   * client-side against `CategoryListResponse` — silently changing it here
   * would 404 every link pointing at the old one with nothing to redirect it.
   * `sortOrder` has its own route, `PUT /admin/categories/reorder`, the same
   * split `reorder`/`setRestrictions` already draw for products.
   */
  async updateCategory(id: string, input: UpdateCategory): Promise<Category> {
    return this.runWrite(async (tx) => {
      const existing = await tx.category.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (existing === null) {
        throw CatalogError.notFound("Category");
      }

      const updated = await tx.category.update({
        where: { id },
        data: { name: toJsonObject(input.name) },
      });

      await this.enqueueRevalidation(tx, CATALOG_TOPICS.categoryUpdated);
      return mapCategoryEntity(updated);
    }, "Category");
  }

  /**
   * The category list's manual display order, the same "array position is
   * the value, and a since-deleted id is silently dropped rather than failing
   * the whole batch" shape `reorder` above uses for products.
   */
  async reorderCategories(input: ReorderCategories): Promise<{ reordered: number }> {
    const live = await this.prisma.category.findMany({
      where: { id: { in: [...input.categoryIds] }, deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((row) => row.id));
    const ordered = input.categoryIds.filter((id) => liveIds.has(id));

    await this.runWrite(async (tx) => {
      for (const [index, id] of ordered.entries()) {
        await tx.category.update({ where: { id }, data: { sortOrder: index } });
      }
      if (ordered.length > 0) {
        await this.enqueueRevalidation(tx, CATALOG_TOPICS.categoryReordered);
      }
    }, "Category");

    return { reordered: ordered.length };
  }

  /**
   * Soft delete. REFUSES while any product — live or already soft-deleted —
   * still carries this category.
   *
   * A category deleted out from under an assigned product would leave
   * `product.categories` pointing at a row the storefront's own nav no longer
   * lists — a dangling reference `product.mapper.ts`'s `categories` include
   * has no `deletedAt` filter to catch, because until this method existed a
   * category could never actually disappear while assigned. Refusing is safer
   * than silently un-assigning: the admin can see exactly which products hold
   * it (each product's own edit screen) and clear them deliberately, rather
   * than a delete click quietly rewriting product data nobody asked to change.
   */
  async removeCategory(id: string): Promise<void> {
    await this.runWrite(async (tx) => {
      const existing = await tx.category.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (existing === null) {
        throw CatalogError.notFound("Category");
      }

      // LIVE PRODUCTS ONLY — matching what the operator's own product count
      // already shows them (`categories.repository.ts`'s `listVisible`).
      // A soft-deleted product's `product_category` row survives the delete
      // (soft delete is a plain UPDATE, not a cascade), and that product can
      // never be reopened to unassign the category either (`setCategories`
      // refuses an archived product) — so counting it here would make the
      // category permanently undeletable with zero recourse, contradicting
      // what "0 products" on the operator's own screen already promised. A
      // DRAFT or ACTIVE product still blocks deletion: it remains editable,
      // so the safety property (no category vanishing from under a product
      // still in use) still holds for the cases where it can actually happen.
      const assigned = await tx.productCategory.count({
        where: { categoryId: id, product: { deletedAt: null } },
      });
      if (assigned > 0) {
        throw CatalogError.conflict(
          `Category is assigned to ${assigned} product(s); remove it from every product first`,
        );
      }

      await tx.category.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.enqueueRevalidation(tx, CATALOG_TOPICS.categoryDeleted);
    }, "Category");
  }

  async setRestrictions(productId: string, input: SetRestrictions): Promise<Product> {
    const updated = await this.prisma.product.updateMany({
      where: { id: productId, deletedAt: null },
      data: { restrictedCountries: input.restrictedCountries },
    });

    if (updated.count === 0) {
      throw CatalogError.notFound("Product");
    }

    return this.getByIdAdmin(productId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Replace the add-ons this product's page offers.
   *
   * TWO CHECKS THE SCHEMA CANNOT MAKE, so they live here — the same split
   * `addMediaSchema.variantId` already uses. A self-reference is rejected by
   * name rather than left to the table's CHECK, and an id that names no live
   * product is a 404 rather than an opaque foreign-key violation surfacing as a
   * 409.
   *
   * IT NEVER TOUCHES `listed`. Attaching a product here says "this page offers
   * it", not "hide it from the grid" — the two axes are orthogonal, and a write
   * that quietly unlisted a product on the operator's behalf would be a
   * merchandising decision nobody made.
   */
  async setAddOns(productId: string, input: SetAddOns): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });

    if (product === null) {
      throw CatalogError.notFound("Product");
    }

    const addOnInput = ProductsService.resolveAddOnInput(input);

    if (addOnInput.some((entry) => entry.id === productId)) {
      throw CatalogError.validation("A product cannot offer itself as an add-on");
    }

    if (addOnInput.length > 0) {
      const live = await this.prisma.product.findMany({
        where: { id: { in: addOnInput.map((entry) => entry.id) }, deletedAt: null },
        select: { id: true },
      });

      if (live.length !== addOnInput.length) {
        throw CatalogError.notFound("Product");
      }
    }

    await this.assertDefaultVariantsBelong(addOnInput);

    await this.runWrite(
      async (tx) => this.replaceAddOns(tx, productId, addOnInput),
      "AddOn",
    );

    return this.getByIdAdmin(productId);
  }

  /**
   * Cross-field pack rules the schema cannot express — it validates `kind` and
   * `packComponents` independently, these are about how the two relate.
   *
   * `resolvedKind` is NOT simply `input.kind ?? "SIMPLE"`: on an UPDATE that
   * touches `packComponents` without resending `kind` (editing an existing
   * pack's component list), defaulting to SIMPLE here would reject a
   * perfectly legitimate call. The caller passes the EXISTING row's kind for
   * exactly that case; `create()` has no existing row, so it passes `undefined`
   * and the SIMPLE default is correct there.
   */
  private assertValidPackComponentInput(
    kind: ProductKind | undefined,
    existingKind: ProductKind | undefined,
    packComponents: readonly { readonly id: string; readonly variantId: string; readonly quantity: number }[] | undefined,
    ownId?: string,
  ): void {
    const resolvedKind = kind ?? existingKind ?? "SIMPLE";

    if (resolvedKind === "PACK") {
      if (packComponents !== undefined && (packComponents.length < 2 || packComponents.length > 6)) {
        throw CatalogError.validation("A pack must name 2 to 6 component products");
      }
    } else if (packComponents !== undefined && packComponents.length > 0) {
      throw CatalogError.validation("Only a PACK product may have pack components");
    }

    if (packComponents === undefined) {
      return;
    }

    const ids = packComponents.map((component) => component.id);
    if (new Set(ids).size !== ids.length) {
      throw CatalogError.validation("A pack cannot list the same component twice");
    }
    if (ownId !== undefined && ids.includes(ownId)) {
      throw CatalogError.validation("A pack cannot include itself as a component");
    }
  }

  /**
   * The pinned variant belongs to the named component product — the composite
   * foreign key on `product_pack_component` already guarantees this at the
   * database level; checked here first for the same reason
   * `assertDefaultVariantsBelong` runs before the transaction for add-ons: a
   * 400 that names what is wrong beats a constraint violation mapped to a
   * generic conflict.
   */
  private async assertPackVariantsBelong(
    packComponents: readonly { readonly id: string; readonly variantId: string; readonly quantity: number }[],
  ): Promise<void> {
    if (packComponents.length === 0) {
      return;
    }
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: packComponents.map((component) => component.variantId) } },
      select: { id: true, productId: true },
    });
    const ownerByVariantId = new Map(variants.map((variant) => [variant.id, variant.productId]));

    for (const component of packComponents) {
      if (ownerByVariantId.get(component.variantId) !== component.id) {
        throw CatalogError.validation(
          `Variant ${component.variantId} does not belong to product ${component.id}`,
        );
      }
    }
  }

  private async replacePackComponents(
    tx: Prisma.TransactionClient,
    packProductId: string,
    packComponents: readonly { readonly id: string; readonly variantId: string; readonly quantity: number }[],
  ): Promise<void> {
    // Delete-then-recreate inside the transaction, so the array's position IS
    // the sort order — the exact shape `replaceAddOns` immediately below
    // already uses.
    await tx.productPackComponent.deleteMany({ where: { packProductId } });
    await tx.productPackComponent.createMany({
      data: packComponents.map((entry, index) => ({
        packProductId,
        componentProductId: entry.id,
        componentVariantId: entry.variantId,
        sortOrder: index,
        quantity: entry.quantity,
      })),
    });
  }

  private async replaceAddOns(
    tx: Prisma.TransactionClient,
    productId: string,
    addOns: readonly ProductAddOnInput[],
  ): Promise<void> {
    // Delete-then-recreate inside the transaction, so the array's position IS
    // the sort order — the shape `replaceCategories` below already uses.
    await tx.productAddOn.deleteMany({ where: { productId } });
    await tx.productAddOn.createMany({
      data: addOns.map((entry, index) => ({
        productId,
        addOnId: entry.id,
        sortOrder: index,
        defaultVariantId: entry.defaultVariantId,
      })),
    });
  }

  /**
   * The add-on list a write actually acts on.
   *
   * TWO FIELDS, ONE MEANING, FOR ONE RELEASE. `addOns` carries a default variant
   * per add-on; `addOnIds` is what the previous dashboard build sends and cannot
   * be dropped yet, because request schemas are `.strict()` and the dashboard is
   * deployed AFTER the API — an API accepting only the new shape would reject
   * every save from the build still running.
   *
   * NON-EMPTY WINS, rather than "defined wins". Both fields carry `.default([])`,
   * so after parsing they are ALWAYS present and "the caller sent this" is no
   * longer distinguishable from "zod filled it in". Every real case still
   * resolves correctly: the old client sends ids with `addOns` defaulted empty,
   * the new client sends `addOns` with ids defaulted empty, and a caller clearing
   * its add-ons sends both empty, which means the same thing either way.
   */
  private static resolveAddOnInput(input: {
    readonly addOns?: readonly ProductAddOnInput[] | undefined;
    readonly addOnIds?: readonly string[] | undefined;
  }): readonly ProductAddOnInput[] {
    const rich = input.addOns ?? [];
    if (rich.length > 0) return rich;
    return (input.addOnIds ?? []).map((id) => ({ id, defaultVariantId: null }));
  }

  /**
   * A default add-on variant must belong to the add-on it is a default FOR.
   *
   * The composite foreign key guarantees this too, and that is deliberate
   * belt-and-braces — the database is the only thing that holds for writers this
   * service never sees. What it cannot do is say WHICH field is wrong, so this
   * runs first and answers with a named 400.
   *
   * SOFT-DELETED VARIANTS ARE REJECTED. A deleted variant still satisfies the
   * foreign key (the row is present), but pre-selecting one would put a dead SKU
   * in front of a shopper.
   */
  private async assertDefaultVariantsBelong(
    addOns: readonly ProductAddOnInput[],
  ): Promise<void> {
    const wanted = addOns.flatMap((entry) =>
      entry.defaultVariantId === null
        ? []
        : [{ addOnId: entry.id, variantId: entry.defaultVariantId }],
    );

    if (wanted.length === 0) return;

    const rows = await this.prisma.productVariant.findMany({
      where: { id: { in: wanted.map((entry) => entry.variantId) }, deletedAt: null },
      select: { id: true, productId: true },
    });

    const owner = new Map(rows.map((row) => [row.id, row.productId]));

    for (const entry of wanted) {
      if (owner.get(entry.variantId) !== entry.addOnId) {
        throw CatalogError.validation(
          "A pre-selected add-on variant must belong to that add-on",
        );
      }
    }
  }

  /**
   * Attach every add-on that asked to be on NEW products.
   *
   * Runs inside the creating transaction, right after the product row exists,
   * so a product is never briefly visible without the add-ons it is supposed to
   * carry. The flag MATERIALISES ORDINARY EDGES rather than being consulted on
   * read — which is what keeps the join table the single source of truth and
   * lets an operator remove the add-on from one product by deleting one edge.
   *
   * THE OPERATOR'S OWN CHOICES WIN AND COME FIRST. Anything they ticked on the
   * form was nested-created with the product a statement ago; those ids are
   * skipped here, and the automatic ones are appended after them, so the
   * arrangement they chose is not reordered by a flag they did not set today.
   *
   * NOT FILTERED ON `listed`. The flag is the intent, and the form only offers
   * it for a product that is already an add-on. A flagged-but-listed product
   * silently doing nothing would be a worse failure than one that does what its
   * flag says.
   */
  private async attachStickyAddOns(
    tx: Prisma.TransactionClient,
    productId: string,
    explicit: readonly ProductAddOnInput[],
  ): Promise<void> {
    const sticky = await tx.product.findMany({
      where: { offerOnNewProducts: true, deletedAt: null, id: { not: productId } },
      select: { id: true, newProductDefaultVariantId: true },
    });

    if (sticky.length === 0) return;

    const chosen = new Set(explicit.map((entry) => entry.id));
    const room = Math.max(0, ADD_ON_MAX - explicit.length);

    const data = sticky
      .filter((addOn) => !chosen.has(addOn.id))
      .slice(0, room)
      .map((addOn, index) => ({
        productId,
        addOnId: addOn.id,
        sortOrder: explicit.length + index,
        defaultVariantId: addOn.newProductDefaultVariantId,
      }));

    if (data.length > 0) {
      await tx.productAddOn.createMany({ data });
    }
  }

  /**
   * Offer ONE add-on on every product page, in a single transaction.
   *
   * A ONE-TIME ATTACH. It writes an edge to every product that exists right now;
   * products created later do not inherit it. The alternative — a flag unioned
   * in at read time — would stop the edge table being the whole truth and would
   * need an "except these" mechanism before anyone could remove the add-on from
   * a single page.
   *
   * IT APPENDS AND NEVER REPLACES. Each host keeps the add-ons it already had,
   * in the order it already had them, and the new edge takes the next
   * `sortOrder`. Doing this as N calls to `PUT :id/add-ons` would be a
   * read-modify-write per host, which races with a colleague editing one of them
   * and can silently drop their change.
   *
   * IDEMPOTENT, AND HONEST ABOUT WHAT IT SKIPPED. Running it twice attaches
   * nothing the second time, and hosts already at `ADD_ON_MAX` are counted
   * rather than pushed past a cap the dedicated route would have refused.
   *
   * ONLY LISTED HOSTS. Offering bacteriostatic water on the bacteriostatic water
   * page is noise, and an add-on's own page is not a shop window for other
   * add-ons.
   */
  async offerEverywhere(
    addOnId: string,
    input: OfferEverywhere,
  ): Promise<OfferEverywhereResult> {
    const addOn = await this.prisma.product.findFirst({
      where: { id: addOnId, deletedAt: null },
      select: { id: true },
    });

    if (addOn === null) {
      throw CatalogError.notFound("Product");
    }

    await this.assertDefaultVariantsBelong([
      { id: addOnId, defaultVariantId: input.defaultVariantId },
    ]);

    return this.runWrite(async (tx) => {
      const hosts = await tx.product.findMany({
        where: { deletedAt: null, listed: true, id: { not: addOnId } },
        select: { id: true, addOns: { select: { addOnId: true, sortOrder: true } } },
      });

      const data: {
        productId: string;
        addOnId: string;
        sortOrder: number;
        defaultVariantId: string | null;
      }[] = [];
      let alreadyPresent = 0;
      let skippedAtCap = 0;

      for (const host of hosts) {
        if (host.addOns.some((edge) => edge.addOnId === addOnId)) {
          alreadyPresent += 1;
          continue;
        }

        if (host.addOns.length >= ADD_ON_MAX) {
          skippedAtCap += 1;
          continue;
        }

        const nextOrder =
          host.addOns.reduce((max, edge) => Math.max(max, edge.sortOrder), -1) + 1;

        data.push({
          productId: host.id,
          addOnId,
          sortOrder: nextOrder,
          defaultVariantId: input.defaultVariantId,
        });
      }

      if (data.length > 0) {
        await tx.productAddOn.createMany({ data });
        // Every host's page now offers something new, so every host's page is
        // stale. One event for the catalogue rather than one per product.
        await this.enqueueRevalidation(tx, CATALOG_TOPICS.productUpdated);
      }

      return { attached: data.length, alreadyPresent, skippedAtCap };
    }, "AddOn");
  }

  private async replaceCategories(
    tx: Prisma.TransactionClient,
    productId: string,
    categoryIds: readonly string[],
  ): Promise<void> {
    await tx.productCategory.deleteMany({ where: { productId } });
    await tx.productCategory.createMany({
      data: categoryIds.map((categoryId, index) => ({
        productId,
        categoryId,
        sortOrder: index,
      })),
    });
  }

  private async insertVariant(
    tx: Prisma.TransactionClient,
    productId: string,
    input: CreateVariant,
    taxRateBps: number,
    actorId: string,
    stackDiscountEnabled: boolean,
  ): Promise<string> {
    // The admin supplies GROSS — the VAT-inclusive figure a Spanish customer
    // sees on the shelf — and net/tax are derived from it. Deriving tax from
    // net instead would make the displayed price a rounding artefact that
    // drifts by a cent from what the admin typed.
    const gross = toMinor(input.priceGross);
    const components = splitGross(gross, taxRateBps);

    // WHEN THE PRODUCT'S FLAG IS ON, THE SUBMITTED `priceTiers` IS IGNORED
    // OUTRIGHT. The fixed schedule is computed from this variant's OWN price
    // and is the only source of truth — the same trust boundary this function
    // already applies to net/tax above (always re-derived, never accepted).
    const tiers = stackDiscountEnabled
      ? computeStackDiscountTiers(components.gross)
      : input.priceTiers;

    const variant = await tx.productVariant.create({
      data: {
        productId,
        sku: input.sku,
        name: jsonOrDbNull(input.name),
        options: toJsonObject(input.options),
        currency: input.currency,
        priceNet: components.net,
        priceTax: components.tax,
        priceGross: components.gross,
        compareAtGross: input.compareAtGross,
        taxRateBps,
        weightGrams: input.weightGrams,
        priceTiers: {
          create: tiers.map((tier) => ({
            minQuantity: tier.minQuantity,
            unitPriceGross: tier.unitPriceGross,
          })),
        },
        inventory: {
          create: {
            onHand: input.initialStock,
            lowStockThreshold: input.lowStockThreshold,
            allowBackorder: input.allowBackorder,
          },
        },
      },
      select: { id: true, sku: true },
    });

    await this.recordPriceChange(tx, variant.id, {
      currency: input.currency,
      net: components.net,
      tax: components.tax,
      gross: components.gross,
      taxRateBps,
      actorId,
    });

    if (input.initialStock > 0) {
      await tx.inventoryLedgerEntry.create({
        data: {
          variantId: variant.id,
          movement: "RESTOCK",
          quantityDelta: input.initialStock,
          resultingOnHand: input.initialStock,
          actorId,
          reason: "Initial stock on variant creation",
        },
      });
    }

    await this.enqueueRevalidation(tx, CATALOG_TOPICS.variantCreated);

    return variant.id;
  }

  /**
   * Close the open price row and open a new one.
   *
   * A mirrored variant's price cannot be mutated through the gateway at all
   * (contract §12 S4), so the sync consumer needs to know a NEW price exists
   * rather than that a field changed. This table is also what
   * answers "what did this cost in March?" when finance or support asks — a
   * question that has no answer at all if prices are only ever overwritten.
   */
  private async recordPriceChange(
    tx: Prisma.TransactionClient,
    variantId: string,
    price: {
      currency: string;
      net: number;
      tax: number;
      gross: number;
      taxRateBps: number;
      actorId: string;
    },
  ): Promise<void> {
    const now = new Date();

    await tx.priceHistory.updateMany({
      where: { variantId, validTo: null },
      data: { validTo: now },
    });

    await tx.priceHistory.create({
      data: {
        variantId,
        currency: price.currency,
        priceNet: price.net,
        priceTax: price.tax,
        priceGross: price.gross,
        taxRateBps: price.taxRateBps,
        validFrom: now,
        changedBy: price.actorId,
      },
    });
  }

  /**
   * Sanitise translations on their way into the column, and say what changed.
   *
   * THE STORED COPY IS THE AUTHORITATIVE ONE. `description` is rendered as HTML
   * on the storefront, and it is written by an admin — which the repo already
   * treats as hostile input (see `httpUrlSchema`: a compromised staff account is
   * exactly where stored XSS starts). Sanitising here means every consumer of
   * the column inherits the guarantee without knowing the policy exists, and it
   * means a payload is neutralised once at write rather than on every read. The
   * storefront sanitises AGAIN at render, because rows written before this
   * existed never passed through here and a direct database edit never will.
   *
   * `shortDescription` IS DELIBERATELY LEFT ALONE, and this is not an oversight.
   * It renders as PLAIN TEXT, so running it through the sanitiser would escape
   * an admin's literal "<" — turning "10 < 20" into a visible "10 &lt; 20". The
   * escaping is correct for `description` for exactly the same reason it is
   * wrong here: one is parsed as HTML by the browser, the other is not.
   *
   * THE REWRITE IS REPORTED, NOT SWALLOWED. Every locale whose description came
   * out different from what was submitted is named in the result, and the
   * controller turns that into a response header. Sanitising silently would
   * mean an operator pastes a `<script>`, gets a 200, and concludes the editor
   * ate their content at random — see `CONTENT_SANITIZED_HEADER` for why the
   * report travels beside the resource rather than inside it, and why a 400
   * would be the wrong kind of loud.
   */
  private sanitizeTranslations(
    translations: readonly ProductTranslation[],
  ): SanitizedTranslations {
    const stored: ProductTranslation[] = [];
    const sanitizedLocales: Locale[] = [];

    for (const translation of translations) {
      const description = sanitizeRichText(translation.description);

      // Compared against the SUBMITTED string, not against a second pass of the
      // sanitiser. `sanitizeRichText` is idempotent, so re-running it would
      // report "unchanged" for every input including the one that just had a
      // <script> taken out of it — which is precisely the case the operator
      // needs to hear about.
      if (description !== translation.description) {
        sanitizedLocales.push(translation.locale);
      }

      stored.push({ ...translation, description });
    }

    return { stored, sanitizedLocales };
  }

  private assertUniqueSkus(skus: readonly string[]): void {
    const seen = new Set<string>();
    for (const sku of skus) {
      if (seen.has(sku)) {
        // Caught here rather than left to the unique index so the message names
        // the offending SKU; a raw P2002 says only "unique constraint failed".
        throw CatalogError.conflict(`Duplicate SKU in request: ${sku}`);
      }
      seen.add(sku);
    }
  }

  /**
   * Run a write, translating Prisma's constraint errors into domain errors.
   *
   * P2002 (unique violation) reaching the client unhandled leaks the table and
   * column names of a database the caller should know nothing about, and arrives
   * as a 500 for what is really a 409 the caller can fix.
   */
  private async runWrite<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    entity: string,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error: unknown) {
      throw this.translateWriteError(error, entity);
    }
  }

  private translateWriteError(error: unknown, entity: string): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return CatalogError.conflict(
          `${entity} violates a uniqueness constraint${formatTarget(error.meta)}`,
        );
      }
      if (error.code === "P2003" || error.code === "P2025") {
        return CatalogError.validation(
          `${entity} references a record that does not exist`,
        );
      }
    }
    return error;
  }

  /**
   * Enqueue a storefront cache purge for a catalog change.
   *
   * IT USED TO ENQUEUE TWO ROWS. The other was a `catalog.*` domain event whose
   * only consumer was the TagadaPay catalog mirror: a hosted checkout there
   * could reference a mirrored variant and nothing else, so an unmirrored
   * variant could not be sold and every catalog write had to reach the provider.
   * Whop accepts our computed amount directly on the checkout call, so the
   * mirror and its consumer are deleted — and an outbox row whose only handler
   * is gone does not sit harmlessly, it fails routing and dead-letters into
   * /admin/jobs on every single product edit.
   *
   * The event PAYLOADS went with it: ids and changed facts assembled for a
   * reader that no longer exists. `topic` survives as the purge's `reason`,
   * which is the question an operator actually asks of one — what change
   * justified it.
   */
  /**
   * NOTE ON `actorId`, which six of the mutations above no longer accept.
   *
   * It used to ride on the `catalog.*` outbox event, and that event was the only
   * place a product-level mutation recorded WHO made it. Deleting the mirror
   * consumer deleted the event, and with it the last home for the value — so the
   * parameter became one the callers supplied and nothing stored, which is worse
   * than not asking for it.
   *
   * The actor is still recorded where a row exists to hold it:
   * `price_history.changedBy` and `inventory_ledger_entry.actorId`, both of which
   * still take it. General catalog attribution belongs to the `audit` module,
   * which is an empty placeholder; when it ships, these six signatures take the
   * actor back alongside somewhere to put it.
   */
  private async enqueueRevalidation(
    tx: Prisma.TransactionClient,
    topic: CatalogTopic,
  ): Promise<void> {
    // The purge is enqueued, in the SAME
    // transaction as the change that justifies it. An inline `fetch` to the
    // storefront here would be lost whenever the storefront is mid-deploy, and
    // would roll back the product write on a storefront timeout — which is
    // backwards, since our database is the source of truth and the storefront is
    // a cache of it.
    //
    // ONE ROW PER EVENT is deliberately chatty. Deduplicating within a
    // transaction would save a few rows and cost the guarantee: a bulk import
    // emitting 900 events produces 900 purges of the same two tags, which is
    // cheap (invalidating a tag twice is invalidating it once) and impossible to
    // get wrong. A dedupe window is an optimisation for a load level this store
    // does not have.
    await tx.outboxMessage.create({
      data: {
        topic: REVALIDATION_TOPIC,
        payload: {
          tags: [REVALIDATE_TAG_PRODUCTS, REVALIDATE_TAG_CATEGORIES],
          reason: topic,
        },
      },
    });
  }
}

/**
 * Extract the conflicting column names from Prisma's untyped `meta` bag.
 *
 * `meta` is `Record<string, unknown> | undefined` — narrowed rather than cast,
 * because the shape differs per error code and an assertion here would be a
 * guess that holds until the first P2002 on a composite index.
 */
function formatTarget(meta: unknown): string {
  if (typeof meta !== "object" || meta === null || !("target" in meta)) {
    return "";
  }
  const { target } = meta as { target: unknown };
  if (Array.isArray(target)) {
    const fields = target.filter((entry): entry is string => typeof entry === "string");
    return fields.length > 0 ? ` on ${fields.join(", ")}` : "";
  }
  return typeof target === "string" ? ` on ${target}` : "";
}

/**
 * Coerce a validated record into Prisma's `InputJsonObject`.
 *
 * Prisma's Json input type is a recursive union that a `Record<string, string>`
 * does not structurally satisfy, and the usual workaround is `as any`. Rebuilding
 * the object entry-by-entry produces a value that genuinely IS an InputJsonObject
 * rather than one asserted to be.
 */
function toJsonObject(source: Readonly<Record<string, string>>): Prisma.InputJsonObject {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = value;
  }
  return result;
}

/**
 * Null on a nullable Json column must be `Prisma.DbNull` (SQL NULL), not
 * JavaScript `null` — which Prisma would store as the JSON literal `null`, a
 * different value that `name IS NULL` does not match.
 */
function jsonOrDbNull(
  source: Readonly<Record<string, string>> | null,
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return source === null ? Prisma.DbNull : toJsonObject(source);
}

/** Re-exported for the tax resolver's consumers; keeps TaxClass off every import site. */
export type { TaxClass };

/**
 * The object key a product certificate upload writes to: the product id, a
 * timestamp and 8 random bytes. Unguessable — but unguessable is not
 * authorised; the bucket has no anonymous read, and the signature is what it
 * checks. The client never chooses it (`attachCoa` refuses any other shape).
 */
function buildProductCoaKey(productId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(8).toString("hex");
  return `coa/products/${productId}/${stamp}-${suffix}.pdf`;
}
