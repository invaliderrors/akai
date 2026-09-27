import type { ShipmentStatus } from "@akai/contracts";

/**
 * What each shipment status MEANS for the order it belongs to.
 *
 * A TOTAL Record, so a status added to the enum is a compile error here rather
 * than a silent default somewhere downstream — which is exactly what the five
 * Sendcloud states (spec 2026-09-24-sendcloud-shipping §3.7) would otherwise
 * have been: a CANCELLED label counted as "already shipped" would block the
 * replacement shipment, and a FAILED one would stop the order ever reaching
 * DELIVERED.
 *
 *  - `carriesGoods` — the parcel exists (or existed) physically and its lines
 *    count as shipped. False only when no parcel will ever move: a cancelled
 *    label or a refused announcement.
 *  - `terminal` — nothing further will happen to it on its own; the tracking
 *    sweep stops re-reading it.
 */
export interface ShipmentStatusTraits {
  readonly carriesGoods: boolean;
  readonly terminal: boolean;
}

export const SHIPMENT_STATUS_TRAITS: Readonly<Record<ShipmentStatus, ShipmentStatusTraits>> = {
  PENDING: { carriesGoods: true, terminal: false },
  LABEL_CREATED: { carriesGoods: true, terminal: false },
  IN_TRANSIT: { carriesGoods: true, terminal: false },
  AWAITING_PICKUP: { carriesGoods: true, terminal: false },
  // An exception may still resolve (a redelivery, a corrected address), so the
  // sweep keeps reading it; the parcel is real either way.
  EXCEPTION: { carriesGoods: true, terminal: false },
  DELIVERED: { carriesGoods: true, terminal: true },
  RETURNED: { carriesGoods: true, terminal: true },
  LOST: { carriesGoods: true, terminal: true },
  CANCELLED: { carriesGoods: false, terminal: true },
  FAILED: { carriesGoods: false, terminal: true },
};

/** A shipment whose lines count as shipped — everything but CANCELLED / FAILED. */
export function carriesGoods(status: ShipmentStatus): boolean {
  return SHIPMENT_STATUS_TRAITS[status].carriesGoods;
}

export function isTerminalShipmentStatus(status: ShipmentStatus): boolean {
  return SHIPMENT_STATUS_TRAITS[status].terminal;
}
