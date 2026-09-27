import { describe, expect, it, vi } from "vitest";

import { FulfilmentError } from "../../fulfilment/fulfilment.errors";
import { NotConfiguredSendcloudClient } from "../../fulfilment/sendcloud/not-configured-sendcloud.client";
import { SendcloudError } from "../../fulfilment/sendcloud/sendcloud.errors";
import type { SendcloudPort } from "../../fulfilment/sendcloud/sendcloud.port";
import { AdminSendcloudOptionsService } from "./admin-sendcloud-options.service";

function configuredPort(listShippingOptions: SendcloudPort["listShippingOptions"]): SendcloudPort {
  const port = new NotConfiguredSendcloudClient();
  return Object.assign(Object.create(port) as SendcloudPort, {
    isConfigured: true,
    listShippingOptions,
  });
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof FulfilmentError)) {
    throw new Error(`expected a FulfilmentError, got ${String(error)}`);
  }
  return error.reason;
}

describe("AdminSendcloudOptionsService", () => {
  it("asks Sendcloud from the ES sender at 500 g", async () => {
    const list = vi.fn<SendcloudPort["listShippingOptions"]>(async () => []);
    const service = new AdminSendcloudOptionsService(configuredPort(list));

    await expect(service.list("PT")).resolves.toEqual({ country: "PT", options: [] });
    expect(list).toHaveBeenCalledWith({
      fromCountryCode: "ES",
      toCountryCode: "PT",
      weightGrams: 500,
    });
  });

  it("answers the foundation's FULFILMENT_NOT_CONFIGURED when Sendcloud is not set up", async () => {
    const service = new AdminSendcloudOptionsService(new NotConfiguredSendcloudClient());

    expect(await reasonOf(service.list("ES"))).toBe("FULFILMENT_NOT_CONFIGURED");
  });

  it("codes a vendor outage as VENDOR_UNAVAILABLE and a refusal as VENDOR_REJECTED", async () => {
    const down = new AdminSendcloudOptionsService(
      configuredPort(() => Promise.reject(new SendcloudError(503, "unknown", "down"))),
    );
    const refused = new AdminSendcloudOptionsService(
      configuredPort(() => Promise.reject(new SendcloudError(400, "invalid", "bad country"))),
    );

    expect(await reasonOf(down.list("ES"))).toBe("VENDOR_UNAVAILABLE");
    expect(await reasonOf(refused.list("ES"))).toBe("VENDOR_REJECTED");
  });
});
