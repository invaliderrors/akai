import { Prisma } from "@akai/db";
import {
  MIN_SEARCH_TERM_LENGTH,
  type Locale,
  type ProductKind,
  type ProductStatus,
} from "@akai/contracts";

/**
 * Builds the SQL that selects ONE PAGE OF PRODUCT IDS, in order.
 *
 * WHY RAW SQL RATHER THAN prisma.product.findMany:
 * `price_asc`/`price_desc` sort by the minimum price across a product's active
 * variants. Prisma's `orderBy` can only order by a to-ONE relation's field, so a
 * to-many aggregate is not expressible in the query API at all. The realistic
 * alternatives were to load every matching product and sort in memory (unbounded
 * — the whole catalog on page one) or to denormalise a `minPrice` column onto
 * `product` (a schema change this module is not permitted to make, plus a new
 * cache-invalidation obligation on every variant write).
 *
 * WHY *EVERY* SORT GOES THROUGH IT, not just the price ones:
 * the obvious split — Prisma for the easy sorts, SQL for price — means the
 * filter predicates (soft delete, status, category, search, purchasability)
 * exist twice, in two dialects, and the two copies drift. The first symptom of
 * that drift is a soft-deleted product appearing under one sort order and not
 * another. One builder, one set of predicates, five orderings.
 *
 * The query returns IDS ONLY. Hydration is a separate Prisma `findMany` with the
 * shared `productInclude`, so the typed relation loading stays in Prisma's hands
 * and no raw row is ever mapped by hand.
 *
 * INJECTION: every caller-supplied value is bound through `Prisma.sql`'s
 * parameterisation. The only fragments interpolated as SQL text are sort
 * directions chosen by a `switch` over a closed union — never a string from the
 * request.
 */

export type ProductSort =
  | "newest"
  | "price_asc"
  | "price_desc"
  | "name"
  | "best_selling"
  | "manual";

/**
 * Order statuses whose lines count toward "best selling".
 *
 * PAID and everything downstream of it. A PENDING or AWAITING_PAYMENT order is
 * an intention, not a sale, and counting it would let anyone rank a product to
 * the top of the home page by adding it to a cart and abandoning checkout a few
 * hundred times. CANCELLED and FAILED are excluded for the same reason.
 *
 * REFUNDED and PARTIALLY_REFUNDED ARE counted, deliberately: the units did sell,
 * and a returns-adjusted ranking is a different (and much more expensive) metric
 * than the one a storefront carousel needs.
 */
const SOLD_ORDER_STATUSES = [
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

export interface ProductQueryFilters {
  readonly status?: ProductStatus | undefined;
  /** Absent means every kind — the ordinary product list. Admin-only, same reasoning `listed` gives for its own undefined-means-both default. */
  readonly kind?: ProductKind | undefined;
  /**
   * Restrict to catalogue products (`true`) or to add-ons (`false`).
   *
   * UNDEFINED MEANS BOTH, and that is the ADMIN case only. No public caller
   * ever chooses a value: `listPublic` pins it true, `listPublicAddOns` pins it
   * false, and neither public query schema declares a member that reaches it —
   * the same construction that keeps `status` and `includeDeleted` out of reach
   * of a crafted query string. A customer cannot ask for add-ons by asking; the
   * only way to see one in a list is to call the route that means add-ons.
   */
  readonly listed?: boolean | undefined;
  readonly categorySlug?: string | undefined;
  readonly search?: string | undefined;
  readonly includeDeleted: boolean;
  /**
   * Require at least one active, non-deleted variant.
   *
   * True for public reads: a product whose every variant is inactive has
   * nothing purchasable behind it, and listing it produces a detail page where
   * every buy button is disabled. It is also the condition that keeps the
   * contract satisfiable — `productSchema` requires `variants` to be non-empty,
   * so a product filtered down to zero visible variants cannot be serialised.
   */
  readonly requirePurchasableVariant: boolean;
}

export interface ProductQueryOptions extends ProductQueryFilters {
  readonly sort: ProductSort;
  readonly locale: Locale;
  readonly cursor?: string | undefined;
  /** Rows to fetch. The service asks for limit+1 to detect a next page. */
  readonly take: number;
}

/**
 * `int4` maximum, used as the NULL sentinel for ascending price sorts.
 *
 * A product with no active variant has a NULL min price. Left NULL, two things
 * break: `ORDER BY` places NULLs unpredictably relative to the keyset
 * predicate, and — worse — the tuple comparison `(price, id) > (NULL, id)`
 * evaluates to NULL, which is not TRUE, so pagination silently returns an empty
 * page forever once a NULL-priced product is the cursor. COALESCE to a sentinel
 * makes the sort key total, so the comparison is always decidable.
 */
const PRICE_SENTINEL_ASC = 2_147_483_647;
const PRICE_SENTINEL_DESC = -1;

/**
 * Escape LIKE metacharacters in user input.
 *
 * Without this, a search for "50%" matches every row (the `%` is a wildcard),
 * and "a_b" matches "axb". Backslash is escaped FIRST — doing it after would
 * double-escape the backslashes this function itself introduces.
 *
 * The catalog search no longer uses it (its term is escaped in SQL, after
 * `unaccent` — see `searchTermCte`); the admin inventory search still does.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** The locale every catalog read falls back to when the active one is missing. */
const FALLBACK_LOCALE: Locale = "es";

/**
 * THE one place a raw `?search=` becomes a term the query uses, or nothing.
 *
 * A term shorter than `MIN_SEARCH_TERM_LENGTH` (shared from contracts with the
 * storefront) is IGNORED rather than rejected: it would match most of the
 * catalogue on a name "contains" and rank nothing usefully.
 *
 * Both the filter predicate and the relevance rank read this, so the two can
 * never disagree about whether a search is active — a rank computed without a
 * filter (or the reverse) would silently reorder or silently empty a page.
 */
export function normaliseSearchTerm(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const term = raw.trim();
  return term.length < MIN_SEARCH_TERM_LENGTH ? undefined : term;
}

/**
 * The search term, bound ONCE and derived in SQL.
 *
 * - `esc` — the accent-folded term with every non-alphanumeric, non-space
 *   character backslash-escaped. A backslash before such a character is a
 *   literal in a LIKE pattern (`ESCAPE '\'`) AND in a Postgres ARE, so one
 *   escaped string serves both `ILIKE` and `~*`. The escaping happens AFTER
 *   `unaccent`, deliberately: unaccent expands some characters into
 *   punctuation ("⑴" → "(1)"), and escaping first would let it mint an
 *   unescaped regex metacharacter out of user input.
 * - `folded` — the accent-folded, lower-cased term, for the exact-name tier.
 * - `lowered` — the lower-cased raw term, for the exact-SKU tier.
 *
 * The term is user input and is only ever a BOUND parameter; the regex that
 * escapes it is a constant of this file.
 */
function searchTermCte(term: string): Prisma.Sql {
  return Prisma.sql`search_term AS (
      SELECT
        regexp_replace(unaccent(s.raw), '([^[:alnum:][:space:]])', '\\\\\\1', 'g') AS esc,
        lower(unaccent(s.raw))                                                  AS folded,
        lower(s.raw)                                                            AS lowered
      FROM (SELECT CAST(${term} AS text) AS raw) s
    ),`;
}

/**
 * Relevance tier for a search hit, lower is better:
 *
 *   0 exact name or exact SKU · 1 name starts with the term as a WHOLE word ·
 *   2 name prefix · 3 name word start · 4 name contains ·
 *   5 short-description word start · 6 description word start ·
 *   7 SKU contains (the only remaining way in)
 *
 * Tier 1 splits the prefix tier so that "kumo" puts "KUMO Hoodie" ahead of
 * "Kumogata Tee": both are prefixes, but only one is the word typed.
 *
 * Name tiers read the SAME translation row the filter does (`t`, active locale
 * → es → first). Descriptions match on WORD STARTS (`\m`), never substrings,
 * which is the whole point: "tee" must find "Tee" and "Teeshirt", not every
 * page that says "Yankee", "settee" or "coteen".
 */
const SEARCH_RANK = Prisma.sql`CASE
        WHEN lower(unaccent(t.name)) = st.folded
          OR EXISTS (
            SELECT 1 FROM "product_variant" vx
            WHERE vx."productId" = p.id
              AND vx."deletedAt" IS NULL
              AND lower(vx.sku) = st.lowered
          )                                                        THEN 0
        WHEN unaccent(t.name) ~* ('^' || st.esc || '\\M')             THEN 1
        WHEN unaccent(t.name) ILIKE (st.esc || '%') ESCAPE '\\'      THEN 2
        WHEN unaccent(t.name) ~* ('\\m' || st.esc)                   THEN 3
        WHEN unaccent(t.name) ILIKE ('%' || st.esc || '%') ESCAPE '\\' THEN 4
        WHEN unaccent(t."shortDescription") ~* ('\\m' || st.esc)     THEN 5
        WHEN unaccent(t.description) ~* ('\\m' || st.esc)            THEN 6
        ELSE 7
      END`;

function buildFilters(options: ProductQueryFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];

  if (!options.includeDeleted) {
    conditions.push(Prisma.sql`p."deletedAt" IS NULL`);
  }

  if (options.status !== undefined) {
    // Cast the bound text parameter to the Postgres enum Prisma generated.
    // Without the cast Postgres reports "operator does not exist: ProductStatus = text".
    conditions.push(Prisma.sql`p.status = ${options.status}::"ProductStatus"`);
  }

  if (options.listed !== undefined) {
    // A plain bound boolean — no enum cast, because `listed` is a Postgres
    // `boolean` column rather than one of Prisma's generated enum types.
    conditions.push(Prisma.sql`p.listed = ${options.listed}`);
  }

  if (options.kind !== undefined) {
    conditions.push(Prisma.sql`p.kind = ${options.kind}::"ProductKind"`);
  }

  if (options.categorySlug !== undefined) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "product_category" pc
      JOIN "category" c ON c.id = pc."categoryId"
      WHERE pc."productId" = p.id
        AND c.slug = ${options.categorySlug}
        AND c."deletedAt" IS NULL
    )`);
  }

  if (normaliseSearchTerm(options.search) !== undefined) {
    // The ACTIVE locale's translation (the `t` lateral: active → es → first),
    // not every locale: a Spanish HTML description must not pull a product
    // into an English visitor's results. SKU stays in because it is how staff
    // and repeat customers actually search. `st` is the `search_term` CTE,
    // cross-joined only when a search is active. Every predicate here has a
    // tier in SEARCH_RANK; the two lists must stay in step.
    conditions.push(Prisma.sql`(
      unaccent(t.name) ILIKE ('%' || st.esc || '%') ESCAPE '\\'
      OR unaccent(t."shortDescription") ~* ('\\m' || st.esc)
      OR unaccent(t.description) ~* ('\\m' || st.esc)
      OR EXISTS (
        SELECT 1 FROM "product_variant" vs
        WHERE vs."productId" = p.id
          AND vs."deletedAt" IS NULL
          AND vs.sku ILIKE ('%' || st.esc || '%') ESCAPE '\\'
      )
    )`);
  }

  if (options.requirePurchasableVariant) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "product_variant" v2
      WHERE v2."productId" = p.id
        AND v2."deletedAt" IS NULL
        AND v2."isActive" = TRUE
    )`);
  }

  return conditions;
}

interface SortPlan {
  /** ORDER BY clause, applied identically to the page query. */
  readonly orderBy: Prisma.Sql;
  /**
   * Keyset predicate against the cursor row's sort key. A tuple comparison
   * rather than `OFFSET`: offsets skip or duplicate rows when a write lands
   * between page fetches, and on a catalog that means a product a customer was
   * scrolling toward silently disappearing.
   */
  readonly keyset: (cursor: string) => Prisma.Sql;
  readonly priceSentinel: number;
}

function planFor(sort: ProductSort, ranked: boolean): SortPlan {
  switch (sort) {
    case "newest":
      return {
        orderBy: Prisma.sql`ORDER BY candidate.created_at DESC, candidate.id DESC`,
        keyset: (cursor) => Prisma.sql`(candidate.created_at, candidate.id) < (
          SELECT c2.created_at, c2.id FROM candidate c2 WHERE c2.id = ${cursor}::uuid
        )`,
        priceSentinel: PRICE_SENTINEL_ASC,
      };
    case "name":
      return {
        orderBy: Prisma.sql`ORDER BY candidate.sort_name ASC, candidate.id ASC`,
        keyset: (cursor) => Prisma.sql`(candidate.sort_name, candidate.id) > (
          SELECT c2.sort_name, c2.id FROM candidate c2 WHERE c2.id = ${cursor}::uuid
        )`,
        priceSentinel: PRICE_SENTINEL_ASC,
      };
    case "price_asc":
      return {
        orderBy: Prisma.sql`ORDER BY candidate.sort_price ASC, candidate.id ASC`,
        keyset: (cursor) => Prisma.sql`(candidate.sort_price, candidate.id) > (
          SELECT c2.sort_price, c2.id FROM candidate c2 WHERE c2.id = ${cursor}::uuid
        )`,
        priceSentinel: PRICE_SENTINEL_ASC,
      };
    case "price_desc":
      return {
        orderBy: Prisma.sql`ORDER BY candidate.sort_price DESC, candidate.id DESC`,
        keyset: (cursor) => Prisma.sql`(candidate.sort_price, candidate.id) < (
          SELECT c2.sort_price, c2.id FROM candidate c2 WHERE c2.id = ${cursor}::uuid
        )`,
        // Descending puts NULL-priced products LAST, so their sentinel must sort
        // below every real price rather than above it.
        priceSentinel: PRICE_SENTINEL_DESC,
      };
    case "best_selling":
      return {
        orderBy: Prisma.sql`ORDER BY candidate.sort_units DESC, candidate.id DESC`,
        keyset: (cursor) => Prisma.sql`(candidate.sort_units, candidate.id) < (
          SELECT c2.sort_units, c2.id FROM candidate c2 WHERE c2.id = ${cursor}::uuid
        )`,
        priceSentinel: PRICE_SENTINEL_ASC,
      };
    case "manual":
      // TIES BREAK ALPHABETICALLY, NOT BY ID. Every product starts at
      // `sortOrder = 0` — this column's default and every row's value until an
      // admin actually reorders something — so a raw-id tiebreak would make
      // "manual" order look like a random shuffle on a catalogue nobody has
      // touched yet. Falling back to `sort_name` (already computed for every
      // sort by the CTE below) means this mode is indistinguishable from
      // `"name"` until it is genuinely used, which is what makes it safe to be
      // the storefront's actual default rather than an option nobody selects.
      //
      // RELEVANCE LEADS WHEN A SEARCH IS ACTIVE. `manual` is what the
      // storefront sends, so it is the sort a customer searching actually gets;
      // the rank goes in FRONT of the manual keys and into the keyset tuple as
      // well. The cursor stays a bare id — the keyset re-reads the cursor row's
      // keys (rank included) from the same CTE — so ranked pages neither skip
      // nor repeat. An explicitly chosen sort (price, newest…) is left alone:
      // the customer asked for that order, and a search only filters it.
      return ranked
        ? {
            orderBy: Prisma.sql`ORDER BY candidate.sort_rank ASC, candidate.sort_order ASC, candidate.sort_name ASC, candidate.id ASC`,
            keyset: (cursor) => Prisma.sql`(candidate.sort_rank, candidate.sort_order, candidate.sort_name, candidate.id) > (
          SELECT c2.sort_rank, c2.sort_order, c2.sort_name, c2.id FROM candidate c2 WHERE c2.id = ${cursor}::uuid
        )`,
            priceSentinel: PRICE_SENTINEL_ASC,
          }
        : {
            orderBy: Prisma.sql`ORDER BY candidate.sort_order ASC, candidate.sort_name ASC, candidate.id ASC`,
            keyset: (cursor) => Prisma.sql`(candidate.sort_order, candidate.sort_name, candidate.id) > (
          SELECT c2.sort_order, c2.sort_name, c2.id FROM candidate c2 WHERE c2.id = ${cursor}::uuid
        )`,
            priceSentinel: PRICE_SENTINEL_ASC,
          };
  }
}

/**
 * Build the ordered page-of-ids query.
 *
 * Exported and pure so `product-query.test.ts` can assert the generated SQL and
 * bound parameters without a database — which is the only way to test that a
 * search term is parameterised rather than concatenated, and that the keyset
 * predicate matches the ORDER BY direction. A mismatch between those two is the
 * classic pagination bug: it does not error, it just returns the same page
 * forever or skips half the catalog.
 */
export function buildProductPageQuery(options: ProductQueryOptions): Prisma.Sql {
  const searchTerm = normaliseSearchTerm(options.search);
  const plan = planFor(options.sort, searchTerm !== undefined && options.sort === "manual");
  const conditions = buildFilters(options);

  const where =
    conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
      : Prisma.empty;

  const keyset =
    options.cursor === undefined
      ? Prisma.empty
      : Prisma.sql`WHERE ${plan.keyset(options.cursor)}`;

  return Prisma.sql`
    WITH ${searchTerm === undefined ? Prisma.empty : searchTermCte(searchTerm)}
    candidate AS (
      SELECT
        p.id                                            AS id,
        p."createdAt"                                   AS created_at,
        COALESCE(t.name, '')                            AS sort_name,
        COALESCE(pv.min_price, ${plan.priceSentinel})   AS sort_price,
        COALESCE(sold.units, 0)                         AS sort_units,
        p."sortOrder"                                    AS sort_order
        ${searchTerm === undefined ? Prisma.empty : Prisma.sql`, ${SEARCH_RANK} AS sort_rank`}
      FROM "product" p
      ${searchTerm === undefined ? Prisma.empty : Prisma.sql`CROSS JOIN search_term st`}
      LEFT JOIN LATERAL (
        -- Prefer the requested locale, then es, then any translation rather
        -- than sorting the product to the top under an empty name — the same
        -- chain the storefront's view.ts applies. ORDER BY on a boolean puts
        -- TRUE first under DESC; the locale tiebreak keeps the fallback
        -- deterministic across replicas. The search predicates and rank read
        -- this SAME row, so a product is matched in the language it is shown in.
        SELECT tt.name, tt."shortDescription", tt.description
        FROM "product_translation" tt
        WHERE tt."productId" = p.id
        ORDER BY (tt.locale = ${options.locale}::"Locale") DESC,
                 (tt.locale = ${FALLBACK_LOCALE}::"Locale") DESC,
                 tt.locale ASC
        LIMIT 1
      ) t ON TRUE
      LEFT JOIN LATERAL (
        SELECT MIN(v."priceGross") AS min_price
        FROM "product_variant" v
        WHERE v."productId" = p.id
          AND v."deletedAt" IS NULL
          AND v."isActive" = TRUE
      ) pv ON TRUE
      LEFT JOIN LATERAL (
        -- Units sold, summed across every variant of the product on orders that
        -- actually reached a paid state. Joined through product_variant rather
        -- than through order_item.sku, because sku is free text on the line and
        -- a SKU that was reused after a product was retired would attribute one
        -- product's history to another.
        --
        -- Computed for EVERY sort, not only best_selling. The alternative is a
        -- second CTE shape behind a conditional, and the file's own header
        -- explains why one builder with one set of predicates is the point: two
        -- copies drift, and the first symptom of drift is a product visible
        -- under one sort order and not another.
        SELECT SUM(oi.quantity)::int AS units
        FROM "order_item" oi
        JOIN "product_variant" ov ON ov.id = oi."variantId"
        JOIN "order" o ON o.id = oi."orderId"
        WHERE ov."productId" = p.id
          AND o.status IN (${Prisma.join(
            // Each status is a BOUND parameter cast to the enum, never
            // interpolated text — the same discipline the status filter above
            // follows. The list is a module constant, but binding it costs
            // nothing and keeps one rule for how values reach this query.
            SOLD_ORDER_STATUSES.map(
              (status) => Prisma.sql`${status}::"OrderStatus"`,
            ),
            ", ",
          )})
      ) sold ON TRUE
      ${where}
    )
    SELECT candidate.id FROM candidate
    ${keyset}
    ${plan.orderBy}
    LIMIT ${options.take}
  `;
}
