import { describe, expect, it } from "vitest";

import {
  createAffiliateSchema,
  listAffiliatesQuerySchema,
  updateAffiliateSchema,
} from "./affiliate-admin.dto";

const AFFILIATE = {
  name: "Ana García",
  country: "ES",
  socialHandle: "@ana.recovers",
  email: "ana@example.com",
};

describe("createAffiliateSchema", () => {
  it("accepts the four fields the request named", () => {
    expect(createAffiliateSchema.parse(AFFILIATE)).toEqual(AFFILIATE);
  });

  it("is strict — an unknown key is rejected, not silently dropped", () => {
    expect(createAffiliateSchema.safeParse({ ...AFFILIATE, role: "ADMIN" }).success).toBe(
      false,
    );
  });

  it("rejects a country that is not an uppercase ISO-3166-1 alpha-2 code", () => {
    expect(createAffiliateSchema.safeParse({ ...AFFILIATE, country: "es" }).success).toBe(
      false,
    );
  });

  it("trims and then rejects a whitespace-only name or social handle", () => {
    expect(createAffiliateSchema.safeParse({ ...AFFILIATE, name: "   " }).success).toBe(false);
    expect(
      createAffiliateSchema.safeParse({ ...AFFILIATE, socialHandle: "   " }).success,
    ).toBe(false);
  });

  it("rejects a malformed email", () => {
    expect(
      createAffiliateSchema.safeParse({ ...AFFILIATE, email: "not-an-email" }).success,
    ).toBe(false);
  });
});

describe("updateAffiliateSchema", () => {
  it("accepts a partial update — every field is individually optional", () => {
    expect(updateAffiliateSchema.parse({ name: "New Name" })).toEqual({ name: "New Name" });
    expect(updateAffiliateSchema.parse({})).toEqual({});
  });

  it("is strict — an unknown key is rejected, not silently dropped", () => {
    expect(updateAffiliateSchema.safeParse({ role: "ADMIN" }).success).toBe(false);
  });
});

/**
 * Same regression `discount-admin.dto.test.ts` records for
 * `listDiscountsQuerySchema.includeDeleted`: `z.coerce.boolean()` is
 * JavaScript truthiness over text from a query string, which would make
 * `?includeDeleted=false` turn the filter ON.
 */
describe("listAffiliatesQuerySchema.includeDeleted", () => {
  it('parses the STRING "false" as false', () => {
    expect(listAffiliatesQuerySchema.parse({ includeDeleted: "false" }).includeDeleted).toBe(
      false,
    );
  });

  it('parses the STRING "true" as true', () => {
    expect(listAffiliatesQuerySchema.parse({ includeDeleted: "true" }).includeDeleted).toBe(
      true,
    );
  });

  it("defaults to false when the caller omits it", () => {
    expect(listAffiliatesQuerySchema.parse({}).includeDeleted).toBe(false);
  });

  it("rejects a value that is neither, rather than silently coercing it", () => {
    expect(listAffiliatesQuerySchema.safeParse({ includeDeleted: "yes" }).success).toBe(false);
  });
});
