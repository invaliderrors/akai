import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import { PrismaService } from "../prisma/prisma.service";
import { DestinationTaxResolver } from "./destination-tax.resolver";
import { TaxError } from "./tax.errors";

async function buildResolver(
  findFirst: () => Promise<{ rateBps: number } | null>,
): Promise<{ resolver: DestinationTaxResolver; findFirst: ReturnType<typeof vi.fn> }> {
  const spy = vi.fn(findFirst);

  const moduleRef = await Test.createTestingModule({
    providers: [
      DestinationTaxResolver,
      { provide: PrismaService, useValue: { taxRate: { findFirst: spy } } },
    ],
  }).compile();

  return { resolver: moduleRef.get(DestinationTaxResolver), findFirst: spy };
}

describe("DestinationTaxResolver", () => {
  it("returns the configured rate for a destination + class", async () => {
    const { resolver } = await buildResolver(async () => ({ rateBps: 1900 }));
    expect(await resolver.resolveBps("DE", "STANDARD")).toBe(1900);
  });

  /**
   * THE BUG THIS RESOLVER EXISTS TO FIX (issue SEV3): tax must key on the SHIP-TO
   * country, not the store's origin. An order to Germany selects German VAT; the
   * same class in Spain is a different rate and must not be confused.
   */
  it("scopes the lookup to the DESTINATION country and the tax class", async () => {
    const { resolver, findFirst } = await buildResolver(async () => ({ rateBps: 1900 }));

    await resolver.resolveBps("DE", "REDUCED");

    const args: unknown = findFirst.mock.calls[0]?.[0];
    expect(args).toMatchObject({ where: { countryCode: "DE", taxClass: "REDUCED" } });
  });

  /**
   * The tempting fallback for "no configured rate" is 0, which makes the code run
   * and quietly sells the order VAT-free — an under-remittance invisible until the
   * first VAT return. A served destination with no rate is a configuration
   * failure, treated as one.
   */
  it("THROWS rather than defaulting to zero when no rate is configured", async () => {
    const { resolver } = await buildResolver(async () => null);

    await expect(resolver.resolveBps("DE", "STANDARD")).rejects.toThrow(TaxError);
    await expect(resolver.resolveBps("DE", "STANDARD")).rejects.toThrow(
      /No STANDARD tax rate configured for DE/,
    );
  });

  it("does not require a seeded row for ZERO_RATED (reverse charge / exports)", async () => {
    const { resolver, findFirst } = await buildResolver(async () => null);

    expect(await resolver.resolveBps("DE", "ZERO_RATED")).toBe(0);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("prefers the most recently effective rate and respects the validity window", async () => {
    const { resolver, findFirst } = await buildResolver(async () => ({ rateBps: 2100 }));

    await resolver.resolveBps("ES", "STANDARD");

    const call: unknown = findFirst.mock.calls[0]?.[0];
    expect(call).toMatchObject({ orderBy: { validFrom: "desc" } });
    const where =
      typeof call === "object" && call !== null && "where" in call
        ? (call as { where: unknown }).where
        : null;
    expect(JSON.stringify(where)).toContain("validTo");
  });
});
