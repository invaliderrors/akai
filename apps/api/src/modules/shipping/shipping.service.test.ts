import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import type { CurrencyCode, Minor } from "@akai/contracts";
import { toMinor } from "@akai/money";

import { type ShippingRateRow, UNMAPPED_FULFILMENT } from "./shipping-rate.selector";
import type {
  OfferableRateThreshold,
  ShippingRepository,
  ShippingZoneWithRates,
} from "./shipping.repository";
import type { ShippingTaxResolverPort } from "./shipping-tax.resolver";
import { ShippingError } from "./shipping.errors";
import { ShippingService } from "./shipping.service";

const EUR = "EUR" as CurrencyCode;

class FakeShippingRepository implements ShippingRepository {
  readonly zones = new Map<string, ShippingZoneWithRates>();

  offerable: OfferableRateThreshold[] = [];

  findZoneForCountry(countryCode: string): Promise<ShippingZoneWithRates | null> {
    return Promise.resolve(this.zones.get(countryCode) ?? null);
  }

  listOfferableRateThresholds(): Promise<readonly OfferableRateThreshold[]> {
    return Promise.resolve(this.offerable);
  }
}

/** Records every country asked about, so we can assert tax is resolved lazily. */
class FakeTaxResolver implements ShippingTaxResolverPort {
  readonly asked: string[] = [];
  constructor(private readonly bps: number | null = 2100) {}

  resolveBps(countryCode: string): Promise<number> {
    this.asked.push(countryCode);
    if (this.bps === null) {
      throw ShippingError.taxUnconfigured(countryCode);
    }
    return Promise.resolve(this.bps);
  }
}

function flatRate(overrides: Partial<ShippingRateRow> = {}): ShippingRateRow {
  return {
    id: "standard",
    name: { es: "Estándar (2-3 días)", en: "Standard (2-3 days)" },
    strategy: "FLAT",
    priceGross: 605,
    currency: "EUR",
    minValue: null,
    maxValue: null,
    freeOverSubtotal: null,
    isActive: true,
    fulfilment: UNMAPPED_FULFILMENT,
    ...overrides,
  };
}

function harness(bps: number | null = 2100): {
  service: ShippingService;
  repo: FakeShippingRepository;
  tax: FakeTaxResolver;
} {
  const repo = new FakeShippingRepository();
  const tax = new FakeTaxResolver(bps);
  return { service: new ShippingService(repo, tax), repo, tax };
}

const baseInput = {
  countryCode: "ES",
  currency: EUR,
  subtotalGross: toMinor(3000),
  weightGrams: 250,
} as const;

/** `resolveCharge` freezes ONE name onto the order, so it needs the buyer's locale. */
const chargeInput = { ...baseInput, locale: "es" } as const;

describe("ShippingService", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
    h.repo.zones.set("ES", {
      zoneId: "zone-es",
      zoneName: "Spain",
      rates: [flatRate()],
    });
  });

  describe("country restriction", () => {
    it("reports a served country as shippable", async () => {
      await expect(h.service.isShippableTo("ES")).resolves.toBe(true);
    });

    it("reports an unserved country as not shippable", async () => {
      await expect(h.service.isShippableTo("US")).resolves.toBe(false);
    });

    it("refuses to quote a destination with no zone", async () => {
      // The peptide country-ship restriction: absence of a zone IS the block.
      await expect(
        h.service.resolveCharge({ ...chargeInput, countryCode: "US", shippingMethodId: "x" }),
      ).rejects.toBeInstanceOf(ShippingError);
    });

    it("refuses to list options for a destination with no zone", async () => {
      await expect(
        h.service.listOptions({ ...baseInput, countryCode: "US" }),
      ).rejects.toBeInstanceOf(ShippingError);
    });
  });

  describe("resolveCharge", () => {
    it("resolves the chosen method into a net + taxBps charge", async () => {
      const resolved = await h.service.resolveCharge({
        ...chargeInput,
        shippingMethodId: "standard",
      });

      // 605 gross at 21% → net 500, tax 105.
      expect(resolved.priceGross).toBe(605);
      expect(resolved.taxRateBps).toBe(2100);
      expect(resolved.net).toBe(500);
      expect(resolved.charge).toEqual({ net: 500, taxRateBps: 2100 });
      // Stamped in the BUYER'S language. The order is immutable and the
      // confirmation email and invoice reproduce this string, so an English
      // name here is an English name in a Spanish customer's inbox forever.
      expect(resolved.methodName).toBe("Estándar (2-3 días)");
    });

    it("stamps the method name in the order's locale, not the database's", async () => {
      const resolved = await h.service.resolveCharge({
        ...chargeInput,
        locale: "en",
        shippingMethodId: "standard",
      });

      expect(resolved.methodName).toBe("Standard (2-3 days)");
    });

    it("falls back to Spanish when the order's locale has no name", async () => {
      h.repo.zones.set("ES", {
        zoneId: "zone-es",
        zoneName: "Spain",
        rates: [flatRate({ name: { es: "Estándar" } })],
      });

      const resolved = await h.service.resolveCharge({
        ...chargeInput,
        locale: "en",
        shippingMethodId: "standard",
      });

      // A translation gap must not produce a blank line on an invoice.
      expect(resolved.methodName).toBe("Estándar");
    });

    it("never trusts a method id that is not offered for the destination", async () => {
      await expect(
        h.service.resolveCharge({ ...chargeInput, shippingMethodId: "premium-air" }),
      ).rejects.toBeInstanceOf(ShippingError);
    });

    it("rejects when the parcel fits no bracket in the zone", async () => {
      h.repo.zones.set("ES", {
        zoneId: "zone-es",
        zoneName: "Spain",
        rates: [flatRate({ strategy: "WEIGHT", minValue: 0, maxValue: 100 })],
      });

      await expect(
        h.service.resolveCharge({ ...chargeInput, weightGrams: 5000, shippingMethodId: "standard" }),
      ).rejects.toBeInstanceOf(ShippingError);
    });

    it("charges zero net and tax for a free-over-threshold method", async () => {
      h.repo.zones.set("ES", {
        zoneId: "zone-es",
        zoneName: "Spain",
        rates: [flatRate({ freeOverSubtotal: 3000 })],
      });

      const resolved = await h.service.resolveCharge({
        ...chargeInput,
        subtotalGross: toMinor(3000),
        shippingMethodId: "standard",
      });

      expect(resolved.priceGross).toBe(0);
      expect(resolved.net).toBe(0);
      expect(resolved.charge).toEqual({ net: 0, taxRateBps: 2100 });
    });

    it("surfaces a missing tax configuration as an error, not a 0% charge", async () => {
      const unconfigured = harness(null);
      unconfigured.repo.zones.set("ES", {
        zoneId: "zone-es",
        zoneName: "Spain",
        rates: [flatRate()],
      });

      await expect(
        unconfigured.service.resolveCharge({ ...chargeInput, shippingMethodId: "standard" }),
      ).rejects.toBeInstanceOf(ShippingError);
    });
  });

  describe("listOptions", () => {
    it("returns priced options for a served destination", async () => {
      const options = await h.service.listOptions(baseInput);
      expect(options.map((o) => o.rateId)).toEqual(["standard"]);
      expect(options[0]?.priceGross).toBe(605);
    });

    it("returns the branded price on each option", async () => {
      const [option] = await h.service.listOptions(baseInput);
      const price: Minor | undefined = option?.priceGross;
      expect(price).toBe(605);
    });
  });

  describe("freeShippingThreshold", () => {
    it("is the threshold every offerable rate shares", async () => {
      h.repo.offerable = [
        { freeOverSubtotal: 25_000, currency: "EUR" },
        { freeOverSubtotal: 25_000, currency: "EUR" },
      ];
      expect(await h.service.freeShippingThreshold()).toEqual({
        amount: 25_000,
        currency: "EUR",
      });
    });

    it("is null when one offerable rate has no threshold", async () => {
      h.repo.offerable = [
        { freeOverSubtotal: 25_000, currency: "EUR" },
        { freeOverSubtotal: null, currency: "EUR" },
      ];
      expect(await h.service.freeShippingThreshold()).toBeNull();
    });
  });
});
