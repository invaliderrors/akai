import { z } from "zod";

/**
 * Primitives, envelopes and cross-cutting shapes.
 *
 * Every request schema in this lib is `.strict()`. That is not stylistic: under
 * @ts-rest/nest, `.strict()` IS the `forbidNonWhitelisted` behaviour the spec
 * (§7) requires — an unknown key is rejected rather than silently dropped, so a
 * client cannot smuggle a field past validation and have it land in a Prisma
 * `data:` spread.
 */

/** Internal primary keys are UUIDs everywhere. Never expose a sequential id. */
export const idSchema = z.string().uuid();
export type Id = z.infer<typeof idSchema>;

/** Slugs are lowercase kebab; they appear in URLs and must round-trip cleanly. */
export const slugSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case");

/**
 * Emails are lower-cased at the boundary so the citext column (spec §4) and the
 * application agree on identity. Do this HERE, not per-call-site.
 */
export const emailSchema = z
  .string()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

/** ISO-3166-1 alpha-2, uppercase. Drives VAT rate, shipping zone and restrictions. */
export const countryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, "Country must be an uppercase ISO-3166-1 alpha-2 code");

export type CountryCode = z.infer<typeof countryCodeSchema>;

/** The store's supported locales. Mirrors next-intl routing: es is the default. */
export const localeSchema = z.enum(["es", "en"]);
export type Locale = z.infer<typeof localeSchema>;

/** Serialised as an ISO-8601 string on the wire; never a Date across JSON. */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Pagination — cursor-based, never OFFSET.
// ---------------------------------------------------------------------------

/**
 * OFFSET pagination degrades on large tables and double-counts or skips rows
 * when writes land between page fetches — for an orders list that means a
 * customer's order visibly vanishing. Cursor pagination is stable under
 * concurrent writes, so it is the only mode offered.
 */
export const paginationQuerySchema = z
  .object({
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Wraps an item schema into the paginated envelope.
 * `nextCursor` is nullable rather than optional so the absence of a next page is
 * an explicit, serialisable fact rather than a missing key a client might
 * mistake for "not loaded yet".
 */
export function paginatedSchema<T extends z.ZodTypeAny>(
  item: T,
): z.ZodObject<{
  items: z.ZodArray<T>;
  nextCursor: z.ZodNullable<z.ZodString>;
  hasMore: z.ZodBoolean;
}> {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });
}

// ---------------------------------------------------------------------------
// Error envelope — one shape for every non-2xx response in the system.
// ---------------------------------------------------------------------------

/**
 * A closed set of machine-readable codes. Clients branch on `code`, never on
 * `message` (which is human-facing, translatable and free to change) and never
 * on the HTTP status alone (which cannot distinguish "card declined" from
 * "coupon expired").
 */
export const errorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "RATE_LIMITED",
  "PAYMENT_FAILED",
  "OUT_OF_STOCK",
  "PRICE_CHANGED",
  "ILLEGAL_STATE_TRANSITION",
  "INTERNAL_ERROR",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** One field-level problem. `path` is a JSON path into the offending request body. */
export const fieldErrorSchema = z
  .object({
    path: z.string(),
    message: z.string(),
  })
  .strict();

export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * WHICH variant a stock refusal ran short on, and how many units of it are
 * still available to THIS request (stock less the rest of the caller's cart).
 *
 * Exists so a pack refusal can name its short component — "RETA (GLP-3): only
 * 3 left" — instead of a generic sold-out sentence about a pack the shopper
 * can see is on sale. Carries an id and a count, never a name or prose: the
 * client resolves the name from data it already holds, in its own locale, and
 * renders its own translated sentence. It is never rendered as sent.
 */
export const stockShortageSchema = z
  .object({
    variantId: idSchema,
    availableQuantity: z.number().int().min(0),
  })
  .strict();

export type StockShortage = z.infer<typeof stockShortageSchema>;

/**
 * THE error envelope. Every error response in the platform is exactly this
 * shape — the global exception filter in apps/api guarantees it, including for
 * exceptions thrown by framework code that knows nothing about this type.
 *
 * `requestId` is always present so a user can quote one string to support and
 * have the full trace pulled from the logs.
 */
export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string(),
        /** Populated only for VALIDATION_FAILED. Never contains submitted values. */
        fields: z.array(fieldErrorSchema).optional(),
        /**
         * A domain-specific, machine-readable SUB-code that narrows a `code`
         * which is correct but too coarse to act on. Every coupon failure is
         * VALIDATION_FAILED, so without this "your basket is below the
         * minimum" and "that code expired" are the same response and no client
         * can tell a fixable failure from a dead one.
         *
         * PARSED against a domain enum (`discountFailureReasonSchema` and its
         * successors) and NEVER RENDERED: it is an identifier, not a message.
         *
         * Deliberately `z.string()` rather than a union of every domain enum.
         * A module may add a reason without a lockstep client deploy — an
         * unrecognised value simply fails the client's domain parse and the
         * caller falls back to the generic `code`, which is exactly today's
         * behaviour. Optional for the same reason in reverse: an envelope from
         * a module that attaches no reason must keep parsing unchanged.
         *
         * The 64-character cap keeps the field an identifier rather than a
         * side channel for prose (or for something an operator's log viewer
         * would render).
         */
        reason: z.string().max(64).optional(),
        /**
         * Present on an OUT_OF_STOCK refusal that can say which variant ran
         * short (see `stockShortageSchema`). Optional for the same additive
         * reason as `reason`.
         */
        shortage: stockShortageSchema.optional(),
        requestId: z.string(),
        timestamp: isoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** HTTP status for each code — used by the exception filter and by contracts. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  PAYMENT_FAILED: 402,
  OUT_OF_STOCK: 409,
  PRICE_CHANGED: 409,
  ILLEGAL_STATE_TRANSITION: 409,
  INTERNAL_ERROR: 500,
};
