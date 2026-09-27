/**
 * The Sendcloud shipping configuration of 2026-09-24 — ONE definition, used by
 * both `seed.ts` (fresh databases) and `seed-shipping-sendcloud-2026-09-24.ts`
 * (the existing one), so the two can never disagree.
 *
 * Source: spec docs/superpowers/specs/2026-09-24-sendcloud-shipping.md §11a
 * (spike G1, options from ES at 500 g on the real account):
 *
 *   | To          | InPost pickup                               | UPS Access Point |
 *   | ES          | inpost_es:service_point,national_c2c        | yes              |
 *   | PT FR DE IT NL BE | inpost_es:service_point,international_c2c | yes        |
 *   | IE          | NOT AVAILABLE                               | yes              |
 *
 * So:
 *  - The InPost rate in "Spain (mainland)" → SERVICE_POINT, `inpost_es`, the
 *    NATIONAL code, 1–2 days.
 *  - The InPost rate in "European Union" → SERVICE_POINT, `inpost_es`, the
 *    INTERNATIONAL code, 2–4 days.
 *  - IE moves OUT of "European Union" into its own "Ireland" zone, because
 *    InPost cannot ship there and a zone's rates are offered to all its
 *    countries. Ireland gets a COPY of the DHL rate only.
 *  - The DHL rates are left EXACTLY as they are — deliveryType HOME (the
 *    default), no carrier, no option code. Decision D2b is still open: the
 *    account has no DHL at all, and whether the €19.99 rate becomes "UPS Access
 *    Point" or is retired is the client's call. Until then it stays sellable
 *    with labels made by hand, as today. It is NOT marked SERVICE_POINT: a
 *    pickup-point rate with no carrier cannot search points, so checkout would
 *    offer a method nobody can complete.
 *  - No UPS rate is invented (same reason).
 */

export const SPAIN_ZONE_NAME = "Spain (mainland)";
export const EU_ZONE_NAME = "European Union";
export const IRELAND_ZONE_NAME = "Ireland";

/** The EU zone's countries AFTER Ireland moves out. */
export const EU_ZONE_COUNTRIES: readonly string[] = ["PT", "FR", "DE", "IT", "NL", "BE"];
export const IRELAND_ZONE_COUNTRIES: readonly string[] = ["IE"];
export const IRELAND_ZONE_SORT_ORDER = 2;

/** The seed's stable match keys (the English rate names, as every shipping seed uses). */
export const INPOST_RATE_EN = "InPost pickup-point shipping";
export const DHL_RATE_EN = "DHL pickup-point shipping";
/** 2026-09-25: replaces DHL in every zone (decision D2b) — see `ups-replaces-dhl-plan.ts`. */
export const UPS_RATE_EN = "UPS pickup-point shipping";

export type SeedDeliveryType = "HOME" | "SERVICE_POINT";

export interface RateMapping {
  readonly deliveryType: SeedDeliveryType;
  readonly carrierCode: string | null;
  readonly sendcloudOptionCode: string | null;
  readonly transitDaysMin: number | null;
  readonly transitDaysMax: number | null;
}

export const INPOST_NATIONAL_MAPPING: RateMapping = {
  deliveryType: "SERVICE_POINT",
  carrierCode: "inpost_es",
  sendcloudOptionCode: "inpost_es:service_point,national_c2c",
  transitDaysMin: 1,
  transitDaysMax: 2,
};

export const INPOST_INTERNATIONAL_MAPPING: RateMapping = {
  deliveryType: "SERVICE_POINT",
  carrierCode: "inpost_es",
  sendcloudOptionCode: "inpost_es:service_point,international_c2c",
  transitDaysMin: 2,
  transitDaysMax: 4,
};

/**
 * UPS Access Point, the same option code in every served country (spec §11a).
 * Sendcloud quotes a 72 h lead time from ES everywhere; the ranges below are
 * the customer-facing promise and are editable in /admin/shipping.
 */
export const UPS_NATIONAL_MAPPING: RateMapping = {
  deliveryType: "SERVICE_POINT",
  carrierCode: "ups",
  sendcloudOptionCode: "ups:standard/service_point",
  transitDaysMin: 1,
  transitDaysMax: 3,
};

export const UPS_INTERNATIONAL_MAPPING: RateMapping = {
  ...UPS_NATIONAL_MAPPING,
  transitDaysMin: 2,
  transitDaysMax: 4,
};

/** What every rate had before Sendcloud, and what DHL keeps (D2b open). */
export const UNMAPPED: RateMapping = {
  deliveryType: "HOME",
  carrierCode: null,
  sendcloudOptionCode: null,
  transitDaysMin: null,
  transitDaysMax: null,
};

// ---------------------------------------------------------------------------
// The planner — pure, so the idempotency rules are unit-tested without a DB.
// ---------------------------------------------------------------------------

export interface RateSnapshot extends RateMapping {
  readonly id: string;
  /** English name, or null when the Json column holds anything else. */
  readonly nameEn: string | null;
  readonly name: unknown;
  readonly strategy: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly freeOverSubtotal: number | null;
  readonly isActive: boolean;
  readonly deleted: boolean;
}

export interface ZoneSnapshot {
  readonly id: string;
  readonly name: string;
  readonly countryCodes: readonly string[];
  readonly sortOrder: number;
  readonly deleted: boolean;
  readonly rates: readonly RateSnapshot[];
}

/** A rate copied into the Ireland zone: every commercial field of the DHL rate, unmapped. */
export interface CopiedRate {
  readonly name: unknown;
  readonly strategy: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly freeOverSubtotal: number | null;
  readonly isActive: boolean;
}

export type PlannedChange =
  | { readonly kind: "map-rate"; readonly rateId: string; readonly label: string; readonly mapping: RateMapping }
  | { readonly kind: "create-ireland-zone" }
  | { readonly kind: "restore-ireland-zone"; readonly zoneId: string }
  | { readonly kind: "copy-rate-to-ireland"; readonly label: string; readonly rate: CopiedRate }
  | { readonly kind: "set-eu-countries"; readonly zoneId: string; readonly from: readonly string[] };

function sameMapping(rate: RateMapping, mapping: RateMapping): boolean {
  return (
    rate.deliveryType === mapping.deliveryType &&
    rate.carrierCode === mapping.carrierCode &&
    rate.sendcloudOptionCode === mapping.sendcloudOptionCode &&
    rate.transitDaysMin === mapping.transitDaysMin &&
    rate.transitDaysMax === mapping.transitDaysMax
  );
}

function liveRateNamed(zone: ZoneSnapshot, nameEn: string): RateSnapshot | undefined {
  return zone.rates.find((rate) => !rate.deleted && rate.nameEn === nameEn);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((code) => b.includes(code));
}

/**
 * The changes that bring `zones` to the 2026-09-24 Sendcloud configuration.
 * EMPTY when it is already there — which is what makes a second run a no-op.
 *
 * Throws on a database that is not the one this was written for (a zone or an
 * InPost/DHL rate missing): guessing would write a mapping onto the wrong row.
 *
 * ORDER MATTERS and is the order `apply` runs them in, inside ONE transaction:
 * the Ireland zone and its rate exist before IE leaves the EU zone, so even
 * outside the transaction there would be no instant at which IE is unserved.
 */
export function planSendcloudShipping(zones: readonly ZoneSnapshot[]): PlannedChange[] {
  const changes: PlannedChange[] = [];

  const liveZone = (name: string): ZoneSnapshot => {
    const zone = zones.find((candidate) => candidate.name === name && !candidate.deleted);
    if (zone === undefined) {
      throw new Error(`Shipping zone "${name}" does not exist (or is deleted).`);
    }
    return zone;
  };

  const spain = liveZone(SPAIN_ZONE_NAME);
  const eu = liveZone(EU_ZONE_NAME);

  for (const [zone, mapping] of [
    [spain, INPOST_NATIONAL_MAPPING],
    [eu, INPOST_INTERNATIONAL_MAPPING],
  ] as const) {
    const inpost = liveRateNamed(zone, INPOST_RATE_EN);
    if (inpost === undefined) {
      throw new Error(`Zone "${zone.name}" has no live "${INPOST_RATE_EN}" rate.`);
    }
    if (!sameMapping(inpost, mapping)) {
      changes.push({ kind: "map-rate", rateId: inpost.id, label: `[${zone.name}] ${INPOST_RATE_EN}`, mapping });
    }
  }

  // Ireland: zone first, then its DHL copy, then IE leaves the EU zone.
  const ireland = zones.find((candidate) => candidate.name === IRELAND_ZONE_NAME);
  if (ireland === undefined) {
    changes.push({ kind: "create-ireland-zone" });
  } else if (
    ireland.deleted ||
    !sameSet(ireland.countryCodes, IRELAND_ZONE_COUNTRIES) ||
    ireland.sortOrder !== IRELAND_ZONE_SORT_ORDER
  ) {
    changes.push({ kind: "restore-ireland-zone", zoneId: ireland.id });
  }

  const irelandHasDhl = ireland !== undefined && liveRateNamed(ireland, DHL_RATE_EN) !== undefined;
  if (!irelandHasDhl) {
    // The EU zone's DHL rate is the template. After a first run it is still
    // there (only IE left the zone), so a re-run after someone deleted the
    // Ireland copy re-creates it from the same source.
    const dhl = liveRateNamed(eu, DHL_RATE_EN);
    if (dhl === undefined) {
      throw new Error(`Zone "${EU_ZONE_NAME}" has no live "${DHL_RATE_EN}" rate to copy to Ireland.`);
    }
    changes.push({
      kind: "copy-rate-to-ireland",
      label: `[${IRELAND_ZONE_NAME}] ${DHL_RATE_EN}`,
      rate: {
        name: dhl.name,
        strategy: dhl.strategy,
        priceGross: dhl.priceGross,
        currency: dhl.currency,
        minValue: dhl.minValue,
        maxValue: dhl.maxValue,
        freeOverSubtotal: dhl.freeOverSubtotal,
        isActive: dhl.isActive,
      },
    });
  }

  if (!sameSet(eu.countryCodes, EU_ZONE_COUNTRIES)) {
    changes.push({ kind: "set-eu-countries", zoneId: eu.id, from: eu.countryCodes });
  }

  return changes;
}

/**
 * Countries served by more than one live zone. Must be empty: the quote picks
 * the lowest `sortOrder` silently, and the zones admin (spec §7a) enforces one
 * active zone per country — the seed must not hand it a violation.
 */
export function countriesInSeveralZones(zones: readonly ZoneSnapshot[]): string[] {
  const seen = new Map<string, number>();
  for (const zone of zones) {
    if (zone.deleted) continue;
    for (const code of zone.countryCodes) {
      seen.set(code, (seen.get(code) ?? 0) + 1);
    }
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([code]) => code).sort();
}
