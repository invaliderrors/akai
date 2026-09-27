import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { CATALOG_BASE_COUNTRY, TaxRateResolver } from "./tax-rate.resolver";
import { CatalogError } from "./catalog.errors";

async function buildResolver(
  findFirst: () => Promise<{ rateBps: number } | null>,
  baseCountry = "ES",
): Promise<{ resolver: TaxRateResolver; findFirst: ReturnType<typeof vi.fn> }> {
  const spy = vi.fn(findFirst);

  const moduleRef = await Test.createTestingModule({
    providers: [
      TaxRateResolver,
      { provide: PrismaService, useValue: { taxRate: { findFirst: spy } } },
      { provide: CATALOG_BASE_COUNTRY, useValue: baseCountry },
    ],
  }).compile();

  return { resolver: moduleRef.get(TaxRateResolver), findFirst: spy };
}

describe("TaxRateResolver", () => {
  it("returns the configured rate for a tax class", async () => {
    const { resolver } = await buildResolver(async () => ({ rateBps: 2100 }));
    expect(await resolver.resolveBps("STANDARD")).toBe(2100);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * The tempting fallback for "no configured rate" is 0, which makes the code
   * run and quietly sells every unit VAT-free. That error is invisible in
   * testing — the arithmetic is self-consistent, the invoice foots, the
   * customer pays the displayed price — and surfaces as an under-remittance at
   * the first VAT return, by which point every order in the period is wrong and
   * cannot be corrected retroactively.
   */
  it("THROWS rather than defaulting to zero when no rate is configured", async () => {
    const { resolver } = await buildResolver(async () => null);

    await expect(resolver.resolveBps("STANDARD")).rejects.toThrow(CatalogError);
    await expect(resolver.resolveBps("STANDARD")).rejects.toThrow(/No tax rate configured/);
  });

  it("does not require a seeded row for ZERO_RATED", async () => {
    const { resolver, findFirst } = await buildResolver(async () => null);

    // ZERO_RATED is a legal classification, not an absent configuration.
    expect(await resolver.resolveBps("ZERO_RATED")).toBe(0);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the store's base country and the tax class", async () => {
    const { resolver, findFirst } = await buildResolver(async () => ({ rateBps: 1000 }));

    await resolver.resolveBps("REDUCED");

    const args: unknown = findFirst.mock.calls[0]?.[0];
    expect(args).toMatchObject({ where: { countryCode: "ES", taxClass: "REDUCED" } });
  });

  it("prefers the most recently effective rate", async () => {
    const { resolver, findFirst } = await buildResolver(async () => ({ rateBps: 2100 }));

    await resolver.resolveBps("STANDARD");

    // Rates are versioned by validFrom precisely so a scheduled change does not
    // require rewriting history; the newest effective one must win.
    const args: unknown = findFirst.mock.calls[0]?.[0];
    expect(args).toMatchObject({ orderBy: { validFrom: "desc" } });
  });

  it("ignores a rate whose validity window has closed", async () => {
    const { resolver, findFirst } = await buildResolver(async () => ({ rateBps: 2100 }));

    await resolver.resolveBps("STANDARD");

    const call: unknown = findFirst.mock.calls[0]?.[0];
    const where =
      typeof call === "object" && call !== null && "where" in call
        ? (call as { where: unknown }).where
        : null;

    expect(JSON.stringify(where)).toContain("validTo");
  });
});
