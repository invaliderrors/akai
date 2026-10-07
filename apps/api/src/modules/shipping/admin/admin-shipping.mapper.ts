import {
  shippingStrategySchema,
  toMinor,
  type AdminShippingRate,
  type AdminShippingZoneDetail,
  type ShippingStrategy,
} from "@akai/contracts";

import { narrowLocalizedText } from "../../../common/localized-text";

/**
 * Prisma rows → the admin wire shapes.
 *
 * STRUCTURAL row types rather than `Prisma.ShippingRate`, the
 * `discount-admin.service.ts` convention: a column rename fails to compile HERE
 * instead of silently flowing a wrong value onto the wire.
 */
export interface ShippingRateRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly name: unknown;
  readonly strategy: string;
  readonly priceGross: number;
  readonly currency: string;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly freeOverSubtotal: number | null;
  readonly isActive: boolean;
  readonly transitDaysMin: number | null;
  readonly transitDaysMax: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ShippingZoneRecord {
  readonly id: string;
  readonly name: string;
  readonly countryCodes: readonly string[];
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The column is a VARCHAR, the contract an enum. A value outside it cannot be
 * sold (the selector refuses it) and cannot be shown truthfully either, so it
 * is a loud data fault rather than a guess.
 */
export function narrowStrategy(value: string): ShippingStrategy {
  const parsed = shippingStrategySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`shipping_rate.strategy holds an unknown value: ${JSON.stringify(value)}`);
  }
  return parsed.data;
}

export function toAdminShippingRate(row: ShippingRateRecord): AdminShippingRate {
  // Parsed, never cast — see `narrowLocalizedText`. Only the two locales the
  // contract carries are projected; an unparseable name reads as "no name",
  // which the editor shows as an empty field for staff to fill.
  const name = narrowLocalizedText(row.name);
  return {
    id: row.id,
    zoneId: row.zoneId,
    name: {
      ...(name.es === undefined ? {} : { es: name.es }),
      ...(name.en === undefined ? {} : { en: name.en }),
    },
    strategy: narrowStrategy(row.strategy),
    minValue: row.minValue,
    maxValue: row.maxValue,
    priceGross: toMinor(row.priceGross),
    currency: row.currency,
    freeOverSubtotal: row.freeOverSubtotal === null ? null : toMinor(row.freeOverSubtotal),
    isActive: row.isActive,
    transitDaysMin: row.transitDaysMin,
    transitDaysMax: row.transitDaysMax,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAdminShippingZone(
  zone: ShippingZoneRecord,
  rates: readonly ShippingRateRecord[],
): AdminShippingZoneDetail {
  return {
    id: zone.id,
    name: zone.name,
    countryCodes: [...zone.countryCodes],
    sortOrder: zone.sortOrder,
    createdAt: zone.createdAt.toISOString(),
    updatedAt: zone.updatedAt.toISOString(),
    rates: rates.map(toAdminShippingRate),
  };
}
