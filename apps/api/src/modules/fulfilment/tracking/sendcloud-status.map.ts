import type { ShipmentStatus } from "@akai/contracts";

import { isTerminalShipmentStatus } from "../../orders/shipment-status";

/**
 * Sendcloud v3 parcel status code → our `ShipmentStatus`.
 *
 * The code list is the one `GET /parcels/statuses` returned on the real account
 * (spec 2026-09-24-sendcloud-shipping §11a G4), and the table below is that
 * section's mapping verbatim. It is a TOTAL `Record` over the tuple, so a code
 * added to the list without a mapping is a compile error, and the unit test
 * walks every entry.
 *
 * `UNKNOWN` is deliberately NOT in the table: it — like any code Sendcloud adds
 * after this was written — maps to `null`, which the sync applies as "no status
 * change, log it". Spec G4 fixes the failure direction: an unrecognised code
 * must never be able to mark a parcel DELIVERED (and, with it, the order).
 */
export const SENDCLOUD_STATUS_CODES = [
  "READY_TO_SEND",
  "ANNOUNCED",
  "ANNOUNCING",
  "NO_LABEL",
  "TO_SORTING",
  "SORTING",
  "SORTED",
  "UNSORTED",
  "AT_SORTING_CENTRE",
  "SHIPMENT_ON_ROUTE",
  "DRIVER_ON_ROUTE",
  "PICKED_UP_BY_DRIVER",
  "DELAYED",
  "AT_CUSTOMS",
  "DELIVERY_METHOD_CHANGED",
  "DELIVERY_DATE_CHANGED",
  "DELIVERY_ADDRESS_CHANGED",
  "AWAITING_CUSTOMER_PICKUP",
  "DELIVERED",
  "COLLECTED_BY_CUSTOMER",
  "RETURNED_TO_SENDER",
  "REFUSED_BY_RECIPIENT",
  "CANCELLING_UPSTREAM",
  "CANCELLING",
  "CANCELLED",
  "CANCELLED_UPSTREAM",
  "ANNOUNCED_UNCOLLECTED",
  "ANNOUNCEMENT_FAILED",
  "DELIVERY_FAILED",
  "COLLECT_ERROR",
  "UNDELIVERABLE",
  "EXCEPTION",
  "ADDRESS_INVALID",
  "CANCELLATION_FAILED",
] as const;

export type SendcloudStatusCode = (typeof SENDCLOUD_STATUS_CODES)[number];

export const SENDCLOUD_STATUS_MAP: Readonly<Record<SendcloudStatusCode, ShipmentStatus>> = {
  // Label bought, the carrier has not touched it.
  READY_TO_SEND: "LABEL_CREATED",
  ANNOUNCED: "LABEL_CREATED",
  ANNOUNCING: "LABEL_CREATED",
  NO_LABEL: "LABEL_CREATED",
  // Moving. The FIRST of these we see is "the first scan" (decision D4).
  TO_SORTING: "IN_TRANSIT",
  SORTING: "IN_TRANSIT",
  SORTED: "IN_TRANSIT",
  UNSORTED: "IN_TRANSIT",
  AT_SORTING_CENTRE: "IN_TRANSIT",
  SHIPMENT_ON_ROUTE: "IN_TRANSIT",
  DRIVER_ON_ROUTE: "IN_TRANSIT",
  PICKED_UP_BY_DRIVER: "IN_TRANSIT",
  DELAYED: "IN_TRANSIT",
  AT_CUSTOMS: "IN_TRANSIT",
  DELIVERY_METHOD_CHANGED: "IN_TRANSIT",
  DELIVERY_DATE_CHANGED: "IN_TRANSIT",
  DELIVERY_ADDRESS_CHANGED: "IN_TRANSIT",
  AWAITING_CUSTOMER_PICKUP: "AWAITING_PICKUP",
  DELIVERED: "DELIVERED",
  COLLECTED_BY_CUSTOMER: "DELIVERED",
  RETURNED_TO_SENDER: "RETURNED",
  REFUSED_BY_RECIPIENT: "RETURNED",
  CANCELLING_UPSTREAM: "CANCELLED",
  CANCELLING: "CANCELLED",
  CANCELLED: "CANCELLED",
  CANCELLED_UPSTREAM: "CANCELLED",
  ANNOUNCED_UNCOLLECTED: "CANCELLED",
  ANNOUNCEMENT_FAILED: "FAILED",
  DELIVERY_FAILED: "EXCEPTION",
  COLLECT_ERROR: "EXCEPTION",
  UNDELIVERABLE: "EXCEPTION",
  EXCEPTION: "EXCEPTION",
  ADDRESS_INVALID: "EXCEPTION",
  CANCELLATION_FAILED: "EXCEPTION",
};

function isKnownCode(code: string): code is SendcloudStatusCode {
  return Object.prototype.hasOwnProperty.call(SENDCLOUD_STATUS_MAP, code);
}

/**
 * The mapped status, or `null` for `UNKNOWN`, an absent code and any code this
 * table does not know. `null` means "leave the shipment's status alone".
 *
 * Case-sensitive on purpose: the vendor sends upper snake case, and a code in
 * any other shape is not one we have evidence for.
 */
export function mapSendcloudStatus(code: string | null | undefined): ShipmentStatus | null {
  if (code === null || code === undefined || !isKnownCode(code)) {
    return null;
  }
  return SENDCLOUD_STATUS_MAP[code];
}

/**
 * The statuses that prove a carrier has physically taken the parcel. Reaching
 * any of them for the first time is "the first scan" (spec §3.7, decision D4):
 * the order becomes SHIPPED and the customer gets `shipping-confirmation`.
 *
 * RETURNED and EXCEPTION are absent: both can be reported for a parcel the
 * carrier never collected (an invalid address caught at announcement, a label
 * returned unused), and telling a customer "it is on its way" on that evidence
 * would be false. An operator is alerted instead.
 */
const CARRIER_HAS_IT: ReadonlySet<ShipmentStatus> = new Set<ShipmentStatus>([
  "IN_TRANSIT",
  "AWAITING_PICKUP",
  "DELIVERED",
]);

export function provesFirstScan(status: ShipmentStatus): boolean {
  return CARRIER_HAS_IT.has(status);
}

/**
 * How far along the journey a status is. Only used between NON-terminal
 * statuses and for the forward-only check below.
 */
const PROGRESS: Readonly<Record<ShipmentStatus, number>> = {
  PENDING: 0,
  LABEL_CREATED: 1,
  FAILED: 1,
  CANCELLED: 1,
  IN_TRANSIT: 2,
  EXCEPTION: 2,
  AWAITING_PICKUP: 3,
  DELIVERED: 4,
  RETURNED: 4,
  LOST: 4,
};

/**
 * The status to write, or `null` for "no change". THE forward-only guard.
 *
 * Webhooks arrive out of order (spec §1 S13) and the sync re-reads the current
 * state, so a regression here would only come from Sendcloud itself reporting an
 * older phase (a stale read replica, a carrier re-sending an old scan). Rules:
 *
 *  - A TERMINAL shipment never changes. DELIVERED stays delivered; a cancelled
 *    or failed label is not resurrected by a late read.
 *  - Never backwards: IN_TRANSIT does not return to LABEL_CREATED, a parcel at
 *    the pickup point does not go back on the van.
 *  - EXCEPTION is sideways, not a phase: any live parcel may enter it, and a
 *    parcel in EXCEPTION may recover to IN_TRANSIT or anything later.
 *  - CANCELLED / FAILED only apply to a label the carrier never scanned. A
 *    cancellation reported after a scan contradicts the parcel's own history, so
 *    it is ignored (and logged by the caller) rather than hiding a real parcel.
 */
export function nextShipmentStatus(
  current: ShipmentStatus,
  reported: ShipmentStatus | null,
): ShipmentStatus | null {
  if (reported === null || reported === current || isTerminalShipmentStatus(current)) {
    return null;
  }

  if (reported === "CANCELLED" || reported === "FAILED") {
    return current === "PENDING" || current === "LABEL_CREATED" ? reported : null;
  }

  if (reported === "EXCEPTION") {
    return reported;
  }

  if (current === "EXCEPTION") {
    return PROGRESS[reported] >= PROGRESS.IN_TRANSIT ? reported : null;
  }

  return PROGRESS[reported] > PROGRESS[current] ? reported : null;
}
