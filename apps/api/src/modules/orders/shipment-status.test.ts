import { describe, expect, it } from "vitest";
import { shipmentStatusSchema } from "@akai/contracts";

import { carriesGoods, isTerminalShipmentStatus } from "./shipment-status";

describe("shipment status traits", () => {
  it("counts every parcel as shipped except a cancelled label or a failed announcement", () => {
    const notShipped = shipmentStatusSchema.options.filter((status) => !carriesGoods(status));
    expect(notShipped.sort()).toEqual(["CANCELLED", "FAILED"]);
  });

  it("keeps tracking everything that can still move", () => {
    const open = shipmentStatusSchema.options.filter(
      (status) => !isTerminalShipmentStatus(status),
    );
    expect(open.sort()).toEqual([
      "AWAITING_PICKUP",
      "EXCEPTION",
      "IN_TRANSIT",
      "LABEL_CREATED",
      "PENDING",
    ]);
  });
});
