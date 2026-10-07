import { describe, expect, it } from "vitest";
import { MIN_SEARCH_TERM_LENGTH } from "@akai/contracts";
import {
  buildProductPageQuery,
  escapeLikePattern,
  normaliseSearchTerm,
  type ProductQueryOptions,
} from "./product-query";

/**
 * The pagination SQL is tested as a PURE FUNCTION, without a database.
 *
 * That is not a compromise for lack of Postgres — it is the only way to assert
 * the two properties that actually matter and that an integration test would
 * not distinguish: that user input is BOUND rather than concatenated, and that
 * the keyset predicate points the same direction as the ORDER BY. A mismatch on
 * the second does not error; it silently returns the same page forever or skips
 * half the catalog, and reads as correct in any single-page test.
 */
function options(overrides: Partial<ProductQueryOptions> = {}): ProductQueryOptions {
  return {
    status: "ACTIVE",
    includeDeleted: false,
    requirePurchasableVariant: true,
    sort: "newest",
    take: 25,
    ...overrides,
  };
}

/** Collapse whitespace so assertions are not hostage to template indentation. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("escapeLikePattern", () => {
  it("escapes the wildcards that would otherwise match everything", () => {
    // Without this, searching "50%" returns the entire catalog.
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("escapes backslashes first so its own escapes are not double-escaped", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  it("leaves ordinary search text untouched", () => {
    expect(escapeLikePattern("camiseta oversize")).toBe("camiseta oversize");
  });
});

describe("normaliseSearchTerm", () => {
  it("trims the term", () => {
    expect(normaliseSearchTerm("  reta  ")).toBe("reta");
  });

  it("ignores a term shorter than the minimum rather than erroring", () => {
    expect(MIN_SEARCH_TERM_LENGTH).toBe(2);
    expect(normaliseSearchTerm("r")).toBeUndefined();
    expect(normaliseSearchTerm(" r ")).toBeUndefined();
    expect(normaliseSearchTerm("   ")).toBeUndefined();
    expect(normaliseSearchTerm(undefined)).toBeUndefined();
  });

  it("keeps a term at exactly the minimum length", () => {
    expect(normaliseSearchTerm("b7")).toBe("b7");
  });
});

describe("buildProductPageQuery — parameterisation", () => {
  it("binds the search term rather than concatenating it into the SQL", () => {
    const query = buildProductPageQuery(options({ search: "camiseta" }));

    // The value appears in the parameter list, never in the statement text.
    expect(query.values).toContain("camiseta");
    expect(normalise(query.sql)).not.toContain("camiseta");
  });

  it("binds a hostile search term instead of interpolating it", () => {
    const injection = "'; DROP TABLE product; --";
    const query = buildProductPageQuery(options({ search: injection }));

    expect(normalise(query.sql)).not.toContain("DROP TABLE");
    expect(query.values).toContain(injection);
  });

  it("binds the category slug, the status and the limit", () => {
    const query = buildProductPageQuery(options({ categorySlug: "recuperacion", take: 7 }));

    expect(query.values).toContain("recuperacion");
    expect(query.values).toContain("ACTIVE");
    expect(query.values).toContain(7);
  });

  it("binds the cursor rather than splicing a uuid into the statement", () => {
    const cursor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const query = buildProductPageQuery(options({ cursor }));

    expect(query.values).toContain(cursor);
    expect(normalise(query.sql)).not.toContain(cursor);
  });
});

describe("buildProductPageQuery — audience filters", () => {
  it("excludes soft-deleted rows by default", () => {
    expect(normalise(buildProductPageQuery(options()).sql)).toContain(
      'p."deletedAt" IS NULL',
    );
  });

  it("includes soft-deleted rows only when explicitly asked", () => {
    const sql = normalise(buildProductPageQuery(options({ includeDeleted: true })).sql);
    expect(sql).not.toContain('p."deletedAt" IS NULL');
  });

  it("requires a purchasable variant for public reads", () => {
    const sql = normalise(buildProductPageQuery(options()).sql);

    expect(sql).toContain('v2."isActive" = TRUE');
    expect(sql).toContain('v2."deletedAt" IS NULL');
  });

  it("drops the purchasable-variant requirement for admin reads", () => {
    const sql = normalise(
      buildProductPageQuery(options({ requirePurchasableVariant: false })).sql,
    );

    expect(sql).not.toContain('v2."isActive" = TRUE');
  });

  /**
   * The listed/add-on split, asserted at the level where it is actually
   * enforced. `listPublic` pins `listed: true`; if this predicate stops being
   * emitted the add-ons quietly reappear on /products and every page still
   * renders, which is exactly the kind of regression no page-shaped test sees.
   */
  it("excludes add-ons from a catalogue listing", () => {
    const query = buildProductPageQuery(options({ listed: true }));

    expect(normalise(query.sql)).toContain("p.listed =");
    expect(query.values).toContain(true);
  });

  it("selects add-ons and nothing else when asked for them", () => {
    const query = buildProductPageQuery(options({ listed: false }));

    expect(normalise(query.sql)).toContain("p.listed =");
    // BOUND, not interpolated — the same discipline every other value here
    // follows, even though a boolean has no injection surface of its own.
    expect(query.values).toContain(false);
  });

  it("omits the listed predicate for an admin read, which sees both", () => {
    const query = buildProductPageQuery(options({ listed: undefined }));

    expect(normalise(query.sql)).not.toContain("p.listed");
  });

  it("omits the status predicate entirely when no status is requested", () => {
    const query = buildProductPageQuery(options({ status: undefined }));

    expect(normalise(query.sql)).not.toContain("p.status =");
    expect(query.values).not.toContain("ACTIVE");
  });

  it("casts bound values to the Postgres enum types Prisma generated", () => {
    const sql = normalise(buildProductPageQuery(options()).sql);

    // Without the casts Postgres reports "operator does not exist:
    // ProductStatus = text" at runtime — a failure no unit test would otherwise
    // see, because the statement is only type-checked by the database.
    expect(sql).toContain('::"ProductStatus"');
  });

  it("ignores a whitespace-only search instead of matching nothing", () => {
    const query = buildProductPageQuery(options({ search: "   " }));
    expect(normalise(query.sql)).not.toContain("ILIKE");
    expect(normalise(query.sql)).not.toContain("search_term");
  });

  it("ignores a one-character search instead of matching half the catalogue", () => {
    const query = buildProductPageQuery(options({ search: "r" }));
    expect(normalise(query.sql)).not.toContain("ILIKE");
    expect(query.values).not.toContain("r");
  });
});

describe("buildProductPageQuery — search matching", () => {
  it("binds the raw term exactly once and derives every pattern from it in SQL", () => {
    const query = buildProductPageQuery(options({ search: "reta" }));
    expect(query.values.filter((value) => value === "reta")).toHaveLength(1);
  });

  it("escapes the term AFTER unaccent, so a character unaccent expands cannot become a metacharacter", () => {
    const sql = normalise(buildProductPageQuery(options({ search: "reta" })).sql);

    // Every non-alphanumeric, non-space character is backslash-escaped, which
    // is a literal in BOTH a LIKE pattern (ESCAPE '\') and a Postgres ARE.
    expect(sql).toContain("regexp_replace(unaccent(s.raw)");
    expect(sql).toContain("'([^[:alnum:][:space:]])'");
    // The replacement reaches SQL as \\\1: an escaped backslash, then the
    // captured character. (A `\1` in a template literal is an invalid escape and
    // silently turns the whole tagged string into `undefined`.)
    expect(sql).toContain("'\\\\\\1', 'g'");
  });

  it("matches the product's own copy columns — there is no translation table to join", () => {
    const sql = normalise(buildProductPageQuery(options({ search: "reta" })).sql);

    expect(sql).not.toContain("product_translation");
    expect(sql).toContain("unaccent(p.name) ILIKE");
  });

  it("matches descriptions on WORD STARTS, never raw substrings", () => {
    const sql = normalise(buildProductPageQuery(options({ search: "reta" })).sql);

    // `\m` is the Postgres word-start anchor: "reta" must not hit "secretagogo".
    expect(sql).toContain("unaccent(p.\"shortDescription\") ~* ('\\m' || st.esc)");
    expect(sql).toContain("unaccent(p.description) ~* ('\\m' || st.esc)");
    expect(sql).not.toContain("p.description ILIKE");
    expect(sql).not.toContain('p."shortDescription" ILIKE');
  });

  it("still matches SKUs on a contains, so staff can look a product up by code", () => {
    const sql = normalise(buildProductPageQuery(options({ search: "AK-CREA" })).sql);
    expect(sql).toContain("vs.sku ILIKE");
  });

  it("accent-folds both sides of every comparison", () => {
    const sql = normalise(buildProductPageQuery(options({ search: "básica" })).sql);
    expect(sql).toContain("unaccent(p.name)");
    // The bound term itself goes through unaccent before it is escaped.
    expect(sql).toContain("unaccent(s.raw)");
  });
});

describe("buildProductPageQuery — relevance ranking", () => {
  const cursor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("ranks exact → whole-word prefix → prefix → word start → contains → short description → description", () => {
    const sql = normalise(buildProductPageQuery(options({ sort: "manual", search: "reta" })).sql);

    const tiers = [
      "st.lowered ) THEN 0", // exact name or SKU
      "'\\M') THEN 1", // name starts with the whole word
      "unaccent(p.name) ILIKE (st.esc || '%') ESCAPE '\\' THEN 2", // name prefix
      "unaccent(p.name) ~* ('\\m' || st.esc) THEN 3", // name word start
      "unaccent(p.name) ILIKE ('%' || st.esc || '%') ESCAPE '\\' THEN 4", // name contains
      "unaccent(p.\"shortDescription\") ~* ('\\m' || st.esc) THEN 5", // short description word start
      "unaccent(p.description) ~* ('\\m' || st.esc) THEN 6", // description word start
      "ELSE 7", // SKU contains
    ];
    let last = -1;
    for (const tier of tiers) {
      const at = sql.indexOf(tier);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(sql).toContain("AS sort_rank");
  });

  it("leads the manual order with the rank, ties broken by the existing manual order", () => {
    const sql = normalise(buildProductPageQuery(options({ sort: "manual", search: "reta" })).sql);
    expect(sql).toContain(
      "ORDER BY candidate.sort_rank ASC, candidate.sort_order ASC, candidate.sort_name ASC, candidate.id ASC",
    );
  });

  it("puts the rank in the keyset tuple too, so pagination over ranked results neither skips nor repeats", () => {
    const sql = normalise(
      buildProductPageQuery(options({ sort: "manual", search: "reta", cursor })).sql,
    );
    expect(sql).toContain(
      "(candidate.sort_rank, candidate.sort_order, candidate.sort_name, candidate.id) > (",
    );
    expect(sql).toContain(
      "SELECT c2.sort_rank, c2.sort_order, c2.sort_name, c2.id FROM candidate c2",
    );
  });

  it("does not rank without a search term", () => {
    const sql = normalise(buildProductPageQuery(options({ sort: "manual" })).sql);
    expect(sql).not.toContain("sort_rank");
  });

  it("leaves an explicitly chosen sort alone: price order is what the customer asked for", () => {
    const sql = normalise(
      buildProductPageQuery(options({ sort: "price_asc", search: "reta" })).sql,
    );
    expect(sql).toContain("ORDER BY candidate.sort_price ASC, candidate.id ASC");
    expect(sql).not.toContain("ORDER BY candidate.sort_rank");
  });
});

describe("buildProductPageQuery — keyset pagination", () => {
  it("emits no keyset predicate on the first page", () => {
    expect(normalise(buildProductPageQuery(options()).sql)).not.toContain("c2.id =");
  });

  /**
   * Direction agreement between ORDER BY and the keyset comparison.
   *
   * Descending sorts must use `<` and ascending must use `>`. Getting this
   * backwards is the classic pagination bug: page 2 returns page 1 again,
   * forever, with no error anywhere.
   */
  it.each([
    ["newest", "DESC", "<"],
    ["price_desc", "DESC", "<"],
    ["price_asc", "ASC", ">"],
    ["name", "ASC", ">"],
  ] as const)(
    "%s orders %s and compares with %s",
    (sort, direction, comparator) => {
      const cursor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const sql = normalise(buildProductPageQuery(options({ sort, cursor })).sql);

      expect(sql).toContain(`candidate.id ${direction}`);
      expect(sql).toContain(`) ${comparator} (`);
    },
  );

  it("always breaks ties on id, so the ordering is total", () => {
    // Without a unique tiebreaker two products sharing a price have an
    // undefined relative order, and a row can be returned on both pages or
    // neither as the plan changes.
    for (const sort of ["newest", "price_asc", "price_desc", "name"] as const) {
      expect(normalise(buildProductPageQuery(options({ sort })).sql)).toMatch(
        /ORDER BY candidate\.[a-z_]+ (ASC|DESC), candidate\.id (ASC|DESC)/,
      );
    }
  });

  /**
   * NULL-priced products (no active variant) get a sentinel so the sort key is
   * total. Left NULL, the tuple comparison evaluates to NULL — not TRUE — and
   * pagination returns an empty page forever once such a product is the cursor.
   */
  it("sorts null prices last in both directions via a sentinel", () => {
    expect(buildProductPageQuery(options({ sort: "price_asc" })).values).toContain(
      2_147_483_647,
    );
    expect(buildProductPageQuery(options({ sort: "price_desc" })).values).toContain(-1);
  });

  it("takes the caller's limit verbatim so the +1 lookahead is preserved", () => {
    expect(buildProductPageQuery(options({ take: 25 })).values).toContain(25);
  });

  it("computes the price key from active, non-deleted variants only", () => {
    const sql = normalise(buildProductPageQuery(options({ sort: "price_asc" })).sql);

    // Sorting by a price the customer cannot actually buy at is a lie in the
    // listing: the card shows one figure and the detail page another.
    expect(sql).toContain('MIN(v."priceGross")');
    expect(sql).toContain('v."isActive" = TRUE');
  });

  it("sorts by the product's own name column", () => {
    const sql = normalise(buildProductPageQuery(options({ sort: "name" })).sql);

    expect(sql).toContain("p.name AS sort_name");
    expect(sql).toContain("ORDER BY candidate.sort_name ASC, candidate.id ASC");
  });

  describe("manual sort", () => {
    it("orders by sortOrder, then falls back to name, then breaks ties on id", () => {
      // THREE columns, not two: every existing product starts at
      // `sortOrder = 0`, so a bare `sortOrder, id` tiebreak would render as a
      // random-looking shuffle on a catalogue nobody has reordered yet. The
      // name tiebreak is what makes "manual" indistinguishable from "name"
      // until an admin genuinely uses it.
      const sql = normalise(buildProductPageQuery(options({ sort: "manual" })).sql);

      expect(sql).toContain(
        "ORDER BY candidate.sort_order ASC, candidate.sort_name ASC, candidate.id ASC",
      );
    });

    it("selects the raw column, not an aggregate — every other sort key needs a join, this one does not", () => {
      const sql = normalise(buildProductPageQuery(options({ sort: "manual" })).sql);
      expect(sql).toContain('p."sortOrder"');
    });

    it("compares all three keyset columns in the same direction as the ORDER BY", () => {
      const cursor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const sql = normalise(buildProductPageQuery(options({ sort: "manual", cursor })).sql);

      expect(sql).toContain(
        "(candidate.sort_order, candidate.sort_name, candidate.id) > (",
      );
      expect(sql).toContain("SELECT c2.sort_order, c2.sort_name, c2.id FROM candidate c2");
    });
  });
});
