import "reflect-metadata";
import { createLogger } from "@akai/observability";
import { describe, expect, it, vi } from "vitest";

import { ShipmentSyncOutboxHandler } from "./shipment-sync.outbox-handler";
import type { ShipmentSyncOutcome } from "./shipment-sync.service";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });
const SHIPMENT_ID = "dddddddd-0000-4000-8000-000000000001";
const MESSAGE = { id: "outbox-1", topic: "shipment-sync", payload: null, attempts: 1 };

function handlerWith(sync: (shipmentId: string) => Promise<ShipmentSyncOutcome>) {
  const spy = vi.fn(sync);
  return { handler: new ShipmentSyncOutboxHandler({ sync: spy }, logger), spy };
}

describe("ShipmentSyncOutboxHandler", () => {
  it("consumes the shipment-sync topic", () => {
    const { handler } = handlerWith(async () => ({ status: "terminal" }));
    expect(handler.topic).toBe("shipment-sync");
  });

  it("syncs the named shipment", async () => {
    const { handler, spy } = handlerWith(async () => ({ status: "terminal" }));
    await handler.handle({ shipmentId: SHIPMENT_ID }, MESSAGE);
    expect(spy).toHaveBeenCalledWith(SHIPMENT_ID);
  });

  it("throws on a payload it cannot parse, so the row dead-letters visibly", async () => {
    const { handler, spy } = handlerWith(async () => ({ status: "terminal" }));
    await expect(handler.handle({ shipmentId: "not-a-uuid" }, MESSAGE)).rejects.toThrow(
      /Unrecognised shipment-sync payload/,
    );
    await expect(handler.handle(null, MESSAGE)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("lets a sync failure propagate, so the dispatcher backs off and retries", async () => {
    const { handler } = handlerWith(async () => {
      throw new Error("Sendcloud 503");
    });
    await expect(handler.handle({ shipmentId: SHIPMENT_ID }, MESSAGE)).rejects.toThrow("Sendcloud 503");
  });
});
