import { shipmentStatusSchema, type ShipmentStatus } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import { isTerminalShipmentStatus } from "../../orders/shipment-status";
import {
  SENDCLOUD_STATUS_CODES,
  SENDCLOUD_STATUS_MAP,
  mapSendcloudStatus,
  nextShipmentStatus,
  provesFirstScan,
} from "./sendcloud-status.map";

/** Spec §11a G4, transcribed independently of the implementation's table. */
const EXPECTED: ReadonlyArray<readonly [string, ShipmentStatus]> = [
  ["READY_TO_SEND", "LABEL_CREATED"],
  ["ANNOUNCED", "LABEL_CREATED"],
  ["ANNOUNCING", "LABEL_CREATED"],
  ["NO_LABEL", "LABEL_CREATED"],
  ["TO_SORTING", "IN_TRANSIT"],
  ["SORTING", "IN_TRANSIT"],
  ["SORTED", "IN_TRANSIT"],
  ["UNSORTED", "IN_TRANSIT"],
  ["AT_SORTING_CENTRE", "IN_TRANSIT"],
  ["SHIPMENT_ON_ROUTE", "IN_TRANSIT"],
  ["DRIVER_ON_ROUTE", "IN_TRANSIT"],
  ["PICKED_UP_BY_DRIVER", "IN_TRANSIT"],
  ["DELAYED", "IN_TRANSIT"],
  ["AT_CUSTOMS", "IN_TRANSIT"],
  ["DELIVERY_METHOD_CHANGED", "IN_TRANSIT"],
  ["DELIVERY_DATE_CHANGED", "IN_TRANSIT"],
  ["DELIVERY_ADDRESS_CHANGED", "IN_TRANSIT"],
  ["AWAITING_CUSTOMER_PICKUP", "AWAITING_PICKUP"],
  ["DELIVERED", "DELIVERED"],
  ["COLLECTED_BY_CUSTOMER", "DELIVERED"],
  ["RETURNED_TO_SENDER", "RETURNED"],
  ["REFUSED_BY_RECIPIENT", "RETURNED"],
  ["CANCELLING_UPSTREAM", "CANCELLED"],
  ["CANCELLING", "CANCELLED"],
  ["CANCELLED", "CANCELLED"],
  ["CANCELLED_UPSTREAM", "CANCELLED"],
  ["ANNOUNCED_UNCOLLECTED", "CANCELLED"],
  ["ANNOUNCEMENT_FAILED", "FAILED"],
  ["DELIVERY_FAILED", "EXCEPTION"],
  ["COLLECT_ERROR", "EXCEPTION"],
  ["UNDELIVERABLE", "EXCEPTION"],
  ["EXCEPTION", "EXCEPTION"],
  ["ADDRESS_INVALID", "EXCEPTION"],
  ["CANCELLATION_FAILED", "EXCEPTION"],
];

const ALL_STATUSES: readonly ShipmentStatus[] = shipmentStatusSchema.options;

describe("mapSendcloudStatus", () => {
  it.each(EXPECTED)("maps %s to %s", (code, status) => {
    expect(mapSendcloudStatus(code)).toBe(status);
  });

  it("covers exactly the 34 known codes (G4 list minus UNKNOWN)", () => {
    expect([...SENDCLOUD_STATUS_CODES].sort()).toEqual(EXPECTED.map(([code]) => code).sort());
    expect(Object.keys(SENDCLOUD_STATUS_MAP).sort()).toEqual([...SENDCLOUD_STATUS_CODES].sort());
  });

  it.each([["UNKNOWN"], ["SOMETHING_NEW_2027"], ["delivered"], [""]])(
    "maps %j to null — never to DELIVERED",
    (code) => {
      expect(mapSendcloudStatus(code)).toBeNull();
    },
  );

  it("maps an absent code to null", () => {
    expect(mapSendcloudStatus(null)).toBeNull();
    expect(mapSendcloudStatus(undefined)).toBeNull();
  });

  it("does not treat inherited object keys as codes", () => {
    expect(mapSendcloudStatus("toString")).toBeNull();
    expect(mapSendcloudStatus("__proto__")).toBeNull();
  });
});

describe("provesFirstScan", () => {
  it("is true only for statuses a carrier can only reach with the parcel in hand", () => {
    const scanned = ALL_STATUSES.filter((status) => provesFirstScan(status));
    expect(scanned.sort()).toEqual(["AWAITING_PICKUP", "DELIVERED", "IN_TRANSIT"]);
  });
});

describe("nextShipmentStatus", () => {
  it("never changes a terminal shipment, whatever is reported", () => {
    for (const current of ALL_STATUSES.filter((status) => isTerminalShipmentStatus(status))) {
      for (const reported of ALL_STATUSES) {
        expect(nextShipmentStatus(current, reported)).toBeNull();
      }
    }
  });

  it("keeps DELIVERED delivered when a stale IN_TRANSIT read arrives", () => {
    expect(nextShipmentStatus("DELIVERED", "IN_TRANSIT")).toBeNull();
  });

  it("ignores an unknown (null) report", () => {
    for (const current of ALL_STATUSES) {
      expect(nextShipmentStatus(current, null)).toBeNull();
    }
  });

  it("moves forward", () => {
    expect(nextShipmentStatus("LABEL_CREATED", "IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(nextShipmentStatus("IN_TRANSIT", "AWAITING_PICKUP")).toBe("AWAITING_PICKUP");
    expect(nextShipmentStatus("AWAITING_PICKUP", "DELIVERED")).toBe("DELIVERED");
    // A first read that is already late skips the phases in between.
    expect(nextShipmentStatus("LABEL_CREATED", "DELIVERED")).toBe("DELIVERED");
    expect(nextShipmentStatus("PENDING", "LABEL_CREATED")).toBe("LABEL_CREATED");
  });

  it("never moves backwards", () => {
    expect(nextShipmentStatus("IN_TRANSIT", "LABEL_CREATED")).toBeNull();
    expect(nextShipmentStatus("AWAITING_PICKUP", "IN_TRANSIT")).toBeNull();
    expect(nextShipmentStatus("AWAITING_PICKUP", "LABEL_CREATED")).toBeNull();
  });

  it("is a no-op when nothing changed", () => {
    expect(nextShipmentStatus("IN_TRANSIT", "IN_TRANSIT")).toBeNull();
  });

  it("lets any live parcel enter EXCEPTION, and recover from it", () => {
    expect(nextShipmentStatus("LABEL_CREATED", "EXCEPTION")).toBe("EXCEPTION");
    expect(nextShipmentStatus("IN_TRANSIT", "EXCEPTION")).toBe("EXCEPTION");
    expect(nextShipmentStatus("AWAITING_PICKUP", "EXCEPTION")).toBe("EXCEPTION");
    expect(nextShipmentStatus("EXCEPTION", "IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(nextShipmentStatus("EXCEPTION", "DELIVERED")).toBe("DELIVERED");
    expect(nextShipmentStatus("EXCEPTION", "LABEL_CREATED")).toBeNull();
  });

  it("applies CANCELLED / FAILED only to a label the carrier never scanned", () => {
    expect(nextShipmentStatus("LABEL_CREATED", "CANCELLED")).toBe("CANCELLED");
    expect(nextShipmentStatus("PENDING", "FAILED")).toBe("FAILED");
    expect(nextShipmentStatus("IN_TRANSIT", "CANCELLED")).toBeNull();
    expect(nextShipmentStatus("AWAITING_PICKUP", "CANCELLED")).toBeNull();
    expect(nextShipmentStatus("EXCEPTION", "CANCELLED")).toBeNull();
  });

  it("lets RETURNED end any live parcel", () => {
    expect(nextShipmentStatus("IN_TRANSIT", "RETURNED")).toBe("RETURNED");
    expect(nextShipmentStatus("AWAITING_PICKUP", "RETURNED")).toBe("RETURNED");
    expect(nextShipmentStatus("EXCEPTION", "RETURNED")).toBe("RETURNED");
  });
});
