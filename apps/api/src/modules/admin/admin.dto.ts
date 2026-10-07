import { z } from "zod";
import {
  countryCodeSchema,
  currencyCodeSchema,
  idSchema,
  localeSchema,
  productStatusSchema,
  slugSchema,
  taxClassSchema,
} from "@akai/contracts";

/**
 * Admin request/response DTOs.
 *
 * zod, `.strict()`, per spec §7 — `.strict()` IS the forbidNonWhitelisted
 * behaviour, so an unknown key is rejected rather than dropped. On the admin
 * surface that matters more than anywhere else: these payloads are spread into
 * catalogue writes, and a silently-accepted extra field is how an attribute
 * nobody validated reaches a `data:` clause.
 */

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Window for every dashboard aggregate.
 *
 * Defaults to the last 30 days rather than all-time: an unbounded default means
 * the owner's first dashboard load does a full table scan on the largest table
 * in the system, and the query gets slower every day the store succeeds.
 */
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 366;

/**
 * The window fields, as a SHAPE rather than a finished schema.
 *
 * Kept separate so a schema that adds a field can `.extend()` it and stay
 * `.strict()`. The previous composition used `metricsWindowQuerySchema.and(...)`,
 * and a zod intersection runs BOTH sides against the FULL input — so the strict
 * left branch rejected the right branch's own key. `?limit=5` was a 400 on
 * `/admin/metrics/top-products`: the single option that endpoint advertises
 * could not be used, and omitting it was the only way to get a 200.
 */
const metricsWindowShape = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  currency: currencyCodeSchema.default("COP"),
} as const;

/** Fills the defaults. Shared so both schemas normalise identically. */
function resolveWindow(query: {
  from?: Date | undefined;
  to?: Date | undefined;
  currency: string;
}): { from: Date; to: Date; currency: string } {
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from, to, currency: query.currency };
}

const windowOrdered = (window: { from: Date; to: Date }): boolean =>
  window.from.getTime() < window.to.getTime();

const windowBounded = (window: { from: Date; to: Date }): boolean =>
  window.to.getTime() - window.from.getTime() <= MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const ORDER_MESSAGE = "`from` must be strictly before `to`";
// A caller-supplied window is caller-supplied query cost. Without an upper bound,
// `?from=1970-01-01` is a trivially-available way to make the database do maximal
// work on an authenticated endpoint.
const BOUND_MESSAGE = `Window may not exceed ${MAX_WINDOW_DAYS} days`;

export const metricsWindowQuerySchema = z
  .object(metricsWindowShape)
  .strict()
  .transform(resolveWindow)
  .refine(windowOrdered, { message: ORDER_MESSAGE })
  .refine(windowBounded, { message: BOUND_MESSAGE });

export type MetricsWindowQuery = z.infer<typeof metricsWindowQuerySchema>;

/**
 * The window PLUS a row cap — one strict object, not an intersection, so `limit`
 * is a known key on the only schema that validates the input.
 */
export const topProductsQuerySchema = z
  .object({
    ...metricsWindowShape,
    limit: z.coerce.number().int().min(1).max(100).default(10),
  })
  .strict()
  .transform((query) => ({ ...resolveWindow(query), limit: query.limit }))
  .refine(windowOrdered, { message: ORDER_MESSAGE })
  .refine(windowBounded, { message: BOUND_MESSAGE });

export const listLimitQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(20) })
  .strict();

// ---------------------------------------------------------------------------
// Audit log listing
// ---------------------------------------------------------------------------

export const auditLogQuerySchema = z
  .object({
    entityType: z.string().max(64).optional(),
    entityId: z.string().max(64).optional(),
    actorId: idSchema.optional(),
    action: z.string().max(80).optional(),
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

const bulkVariantSchema = z
  .object({
    sku: z.string().min(1).max(64),
    /**
     * GROSS, integer minor units. Admins supply what the customer sees and the
     * API derives net and tax — the reverse (admin supplies net) puts a rounding
     * decision in a spreadsheet, where it cannot be audited.
     */
    priceGross: z.number().int().min(0).max(2_000_000_000),
    compareAtGross: z.number().int().min(0).max(2_000_000_000).nullable().default(null),
    currency: currencyCodeSchema,
    weightGrams: z.number().int().positive().nullable().default(null),
    initialStock: z.number().int().min(0).default(0),
    lowStockThreshold: z.number().int().min(0).default(5),
    allowBackorder: z.boolean().default(false),
  })
  .strict()
  .refine(
    (variant) =>
      variant.compareAtGross === null || variant.compareAtGross >= variant.priceGross,
    {
      // A compare-at below the selling price renders as a negative discount and,
      // in several EU jurisdictions, is an unlawful price display.
      message: "compareAtGross must be greater than or equal to priceGross",
      path: ["compareAtGross"],
    },
  );

const bulkTranslationSchema = z
  .object({
    locale: localeSchema,
    name: z.string().min(1).max(200),
    shortDescription: z.string().max(500),
    description: z.string().max(20_000),
  })
  .strict();

export const bulkImportRowSchema = z
  .object({
    slug: slugSchema,
    status: productStatusSchema.default("DRAFT"),
    taxClass: taxClassSchema.default("STANDARD"),
    translations: z.array(bulkTranslationSchema).min(1),
    variants: z.array(bulkVariantSchema).min(1),
    restrictedCountries: z.array(countryCodeSchema).default([]),
  })
  .strict()
  .refine(
    (row) =>
      new Set(row.variants.map((variant) => variant.sku)).size === row.variants.length,
    {
      // Caught here rather than at the unique index, so the admin gets the
      // offending row instead of a database error naming a constraint.
      message: "Duplicate SKU within a single product",
      path: ["variants"],
    },
  )
  .refine(
    (row) =>
      new Set(row.translations.map((translation) => translation.locale)).size ===
      row.translations.length,
    { message: "Duplicate locale in translations", path: ["translations"] },
  );

export type BulkImportRow = z.infer<typeof bulkImportRowSchema>;

/**
 * Cap on rows per import.
 *
 * The request is processed synchronously; beyond a few hundred rows it belongs
 * on the queue as a job (see followUps). A hard cap is an honest limit — an
 * uncapped endpoint that times out at row 2,000 has already half-written the
 * catalogue by the time the client gives up.
 */
export const MAX_IMPORT_ROWS = 500;

export const bulkImportRequestSchema = z
  .object({
    dryRun: z.boolean().default(false),
    products: z.array(bulkImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.products.map((product) => product.slug)).size ===
      request.products.length,
    {
      // Two rows with the same slug would race each other through the upsert and
      // leave whichever landed last silently winning.
      message: "Duplicate slug in import payload",
      path: ["products"],
    },
  );

export type BulkImportRequest = z.infer<typeof bulkImportRequestSchema>;

/** Response schema for the import — also used to validate an idempotent replay. */
export const importRowOutcomeSchema = z
  .object({
    slug: z.string(),
    outcome: z.enum(["created", "updated", "failed", "unchanged"]),
    error: z.string().nullable(),
  })
  .strict();

export const bulkImportReportSchema = z
  .object({
    dryRun: z.boolean(),
    total: z.number().int().min(0),
    created: z.number().int().min(0),
    updated: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    failed: z.number().int().min(0),
    rows: z.array(importRowOutcomeSchema),
  })
  .strict();
