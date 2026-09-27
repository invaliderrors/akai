import "reflect-metadata";
import { BadRequestException, HttpException } from "@nestjs/common";
import type { ServerEnv, SendcloudConfig } from "@akai/config";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FulfilmentError } from "../fulfilment.errors";
import { signSendcloudBody } from "./sendcloud-signature";
import { SendcloudWebhookController } from "./sendcloud-webhook.controller";
import type {
  SendcloudParcelEvent,
  SendcloudWebhookOutcome,
  SendcloudWebhookService,
} from "./sendcloud-webhook.service";

const SECRET = "webhook-signature-key";
const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });

const SENDCLOUD: SendcloudConfig = {
  publicKey: "pub",
  secretKey: "sec",
  webhookSecret: SECRET,
  senderAddressId: 920582,
  mode: "test",
  baseUrl: "https://panel.sendcloud.sc/api/v3",
};

function configWith(sendcloud: SendcloudConfig | null): ServerEnv {
  // Only `sendcloud` is read by this controller.
  return { sendcloud } as unknown as ServerEnv;
}

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

const STATUS_CHANGED = {
  action: "parcel_status_changed",
  timestamp: 1727200000123,
  parcel: { id: 718530367, tracking_number: "SCCWF3P9K4PJ", status: { id: 3, message: "En route" } },
};

describe("SendcloudWebhookController", () => {
  let accept: ReturnType<typeof vi.fn<(event: SendcloudParcelEvent) => Promise<SendcloudWebhookOutcome>>>;
  let controller: SendcloudWebhookController;

  beforeEach(() => {
    accept = vi.fn<(event: SendcloudParcelEvent) => Promise<SendcloudWebhookOutcome>>(async () => ({
      status: "enqueued",
      shipmentId: "s-1",
    }));
    const service = { accept } as unknown as SendcloudWebhookService;
    controller = new SendcloudWebhookController(service, configWith(SENDCLOUD), logger);
  });

  it("accepts a correctly signed delivery and dedupes on parcel id + timestamp", async () => {
    const raw = body(STATUS_CHANGED);
    const ack = await controller.handle({ rawBody: raw }, signSendcloudBody(raw, SECRET));

    expect(ack).toEqual({ received: true, outcome: "enqueued" });
    expect(accept).toHaveBeenCalledTimes(1);
    const [event] = accept.mock.calls[0] ?? [];
    expect(event?.parcelId).toBe(718530367n);
    expect(event?.eventId).toBe("sendcloud:718530367:1727200000123");
    expect(event?.action).toBe("parcel_status_changed");
  });

  it("refuses a tampered body", async () => {
    const raw = body(STATUS_CHANGED);
    const signature = signSendcloudBody(raw, SECRET);
    const tampered = body({ ...STATUS_CHANGED, parcel: { id: 1 } });

    await expect(controller.handle({ rawBody: tampered }, signature)).rejects.toMatchObject({
      response: { code: "INVALID_SIGNATURE" },
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses a missing signature", async () => {
    await expect(controller.handle({ rawBody: body(STATUS_CHANGED) }, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses a signature made with another key", async () => {
    const raw = body(STATUS_CHANGED);
    await expect(controller.handle({ rawBody: raw }, signSendcloudBody(raw, "sec-other"))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("answers the coded FULFILMENT_NOT_CONFIGURED when Sendcloud is off — never a silent 200", async () => {
    const off = new SendcloudWebhookController(
      { accept } as unknown as SendcloudWebhookService,
      configWith(null),
      logger,
    );
    const raw = body(STATUS_CHANGED);

    const error: unknown = await off.handle({ rawBody: raw }, signSendcloudBody(raw, SECRET)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    if (!(error instanceof FulfilmentError)) {
      throw new Error("expected a FulfilmentError");
    }
    expect(error.reason).toBe("FULFILMENT_NOT_CONFIGURED");
    expect(error.getStatus()).toBe(409);
    expect(accept).not.toHaveBeenCalled();
  });

  it("names a missing raw body as a mount bug, not a bad signature", async () => {
    await expect(controller.handle({}, "00")).rejects.toMatchObject({
      response: { code: "RAW_BODY_UNAVAILABLE" },
    });
  });

  it("answers 200 'ignored' for a signed body it cannot parse (no retry storm)", async () => {
    const raw = Buffer.from("not json", "utf8");
    const ack = await controller.handle({ rawBody: raw }, signSendcloudBody(raw, SECRET));
    expect(ack).toEqual({ received: true, outcome: "ignored" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("answers 200 'ignored' for an action other than parcel_status_changed", async () => {
    const raw = body({ action: "integration_connected", timestamp: 1 });
    const ack = await controller.handle({ rawBody: raw }, signSendcloudBody(raw, SECRET));
    expect(ack.outcome).toBe("ignored");
    expect(accept).not.toHaveBeenCalled();
  });

  it("accepts a digit-string parcel id", async () => {
    const raw = body({ ...STATUS_CHANGED, parcel: { id: "718530367" } });
    await controller.handle({ rawBody: raw }, signSendcloudBody(raw, SECRET));
    expect(accept.mock.calls[0]?.[0].parcelId).toBe(718530367n);
  });

  it("falls back to a body digest when the delivery carries no timestamp", async () => {
    const raw = body({ action: "parcel_status_changed", parcel: { id: 5 } });
    await controller.handle({ rawBody: raw }, signSendcloudBody(raw, SECRET));
    expect(accept.mock.calls[0]?.[0].eventId).toMatch(/^sendcloud:5:sha256:[0-9a-f]{40}$/);
  });

  it("passes the service outcome through (duplicate / unmatched are still 200)", async () => {
    accept.mockResolvedValueOnce({ status: "duplicate" });
    const raw = body(STATUS_CHANGED);
    const ack = await controller.handle({ rawBody: raw }, signSendcloudBody(raw, SECRET));
    expect(ack.outcome).toBe("duplicate");
  });
});
