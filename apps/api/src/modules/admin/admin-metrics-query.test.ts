import { describe, expect, it } from "vitest";

import { metricsWindowQuerySchema, topProductsQuerySchema } from "./admin.dto";

/**
 * REGRESSION. `topProductsQuerySchema` was `metricsWindowQuerySchema.and({limit})`,
 * and a zod INTERSECTION validates the full input against BOTH sides. The left
 * side is `.strict()`, so it rejected `limit` as an unknown key: the one option
 * the endpoint advertises returned 400, and omitting it was the only way to get
 * a 200. The failing case is `parse({limit: "5"})` — `parse({})` passed the whole
 * time, which is why nothing caught it.
 */

describe("topProductsQuerySchema", () => {
  it("ACCEPTS a limit — the whole bug", () => {
    const parsed = topProductsQuerySchema.parse({ limit: "5" });
    expect(parsed.limit).toBe(5);
  });

  it("defaults the limit when omitted", () => {
    expect(topProductsQuerySchema.parse({}).limit).toBe(10);
  });

  it("accepts a limit ALONGSIDE an explicit window", () => {
    const parsed = topProductsQuerySchema.parse({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      limit: "3",
    });
    expect(parsed.limit).toBe(3);
    expect(parsed.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("still rejects a genuinely unknown key", () => {
    // The strictness that caused the bug is a feature; only the composition was
    // wrong. A typo'd parameter must not be silently ignored.
    expect(topProductsQuerySchema.safeParse({ limitt: "5" }).success).toBe(false);
  });

  it("still enforces the limit bounds", () => {
    expect(topProductsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(topProductsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });

  it("keeps the window rules the plain window schema has", () => {
    // Inverted window.
    expect(
      topProductsQuerySchema.safeParse({
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);

    // Beyond the maximum span — the cap that stops `?from=1970-01-01` making the
    // database do maximal work on an authenticated endpoint.
    expect(
      topProductsQuerySchema.safeParse({
        from: "1970-01-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("metricsWindowQuerySchema", () => {
  it("still refuses an unknown key", () => {
    expect(metricsWindowQuerySchema.safeParse({ limit: "5" }).success).toBe(false);
  });

  it("defaults to a trailing window ending now", () => {
    const parsed = metricsWindowQuerySchema.parse({});
    expect(parsed.from.getTime()).toBeLessThan(parsed.to.getTime());
    expect(parsed.currency).toBe("EUR");
  });
});
