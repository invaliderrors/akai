/**
 * 2026-09-25 — decision D2b of docs/superpowers/specs/2026-09-24-sendcloud-shipping.md:
 * the Sendcloud account has no DHL, so the "DHL pickup-point" rate is REMOVED
 * from every zone and a "UPS pickup-point" rate at the same €19.99 takes its
 * place. InPost (€8.99) stays where it can ship (Spain, EU); Ireland ends up
 * with UPS only.
 *
 * Pure planner, so the idempotency rules are unit-tested without a database;
 * `seed-shipping-ups-2026-09-25.ts` applies the plan in one transaction.
 *
 * DHL is SOFT-deleted (and deactivated), never hard-deleted: orders placed with
 * it keep their shipping snapshot, and `shippingRateId` would otherwise be
 * nulled on them for no reason.
 */

import { FREE_SHIPPING_THRESHOLD_MINOR } from "./free-shipping-threshold";
import {
  DHL_RATE_EN,
  EU_ZONE_NAME,
  IRELAND_ZONE_NAME,
  type RateMapping,
  SPAIN_ZONE_NAME,
  UPS_INTERNATIONAL_MAPPING,
  UPS_NATIONAL_MAPPING,
  UPS_RATE_EN,
  type ZoneSnapshot,
} from "./sendcloud-shipping-plan";

export const UPS_RATE_NAME = { es: "Envío en punto de recogida UPS", en: UPS_RATE_EN } as const;
export const UPS_RATE_PRICE_GROSS = 1999;

/** Which UPS mapping each zone gets. A zone not listed here is left alone. */
export const UPS_MAPPING_BY_ZONE: Readonly<Record<string, RateMapping>> = {
  [SPAIN_ZONE_NAME]: UPS_NATIONAL_MAPPING,
  [EU_ZONE_NAME]: UPS_INTERNATIONAL_MAPPING,
  [IRELAND_ZONE_NAME]: UPS_INTERNATIONAL_MAPPING,
};

export interface NewUpsRate extends RateMapping {
  readonly name: typeof UPS_RATE_NAME;
  readonly strategy: "FLAT";
  readonly priceGross: number;
  readonly currency: "EUR";
  readonly minValue: null;
  readonly maxValue: null;
  readonly freeOverSubtotal: number;
  readonly isActive: true;
}

export type UpsPlanChange =
  | { readonly kind: "remove-dhl"; readonly rateId: string; readonly label: string }
  | { readonly kind: "create-ups"; readonly zoneId: string; readonly label: string; readonly rate: NewUpsRate }
  | { readonly kind: "map-ups"; readonly rateId: string; readonly label: string; readonly mapping: RateMapping };

export function planUpsReplacesDhl(zones: readonly ZoneSnapshot[]): UpsPlanChange[] {
  const changes: UpsPlanChange[] = [];

  for (const zone of zones) {
    const mapping = UPS_MAPPING_BY_ZONE[zone.name];
    if (zone.deleted || mapping === undefined) continue;

    for (const rate of zone.rates) {
      if (!rate.deleted && rate.nameEn === DHL_RATE_EN) {
        changes.push({ kind: "remove-dhl", rateId: rate.id, label: `[${zone.name}] ${DHL_RATE_EN}` });
      }
    }

    const ups = zone.rates.find((rate) => !rate.deleted && rate.nameEn === UPS_RATE_EN);
    if (ups === undefined) {
      changes.push({
        kind: "create-ups",
        zoneId: zone.id,
        label: `[${zone.name}] ${UPS_RATE_EN}`,
        rate: {
          name: UPS_RATE_NAME,
          strategy: "FLAT",
          priceGross: UPS_RATE_PRICE_GROSS,
          currency: "EUR",
          minValue: null,
          maxValue: null,
          freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
          isActive: true,
          ...mapping,
        },
      });
    } else if (ups.sendcloudOptionCode === null) {
      // A UPS rate someone created by hand without the Sendcloud mapping. Its
      // price and name are theirs to decide — only the mapping is filled in.
      // A MAPPED rate is never touched: staff may have edited it in
      // /admin/shipping, and a re-run must not revert them.
      changes.push({ kind: "map-ups", rateId: ups.id, label: `[${zone.name}] ${UPS_RATE_EN}`, mapping });
    }
  }

  return changes;
}
