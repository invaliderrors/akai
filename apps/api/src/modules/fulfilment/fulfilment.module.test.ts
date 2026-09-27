import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { type ServerEnv, parseServerEnv } from "@akai/config";
import { createLogger } from "@akai/observability";
import { errorEnvelopeSchema } from "@akai/contracts";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { FulfilmentError } from "./fulfilment.errors";
import { FulfilmentModule, createSendcloudClient } from "./fulfilment.module";
import { NotConfiguredSendcloudClient } from "./sendcloud/not-configured-sendcloud.client";
import { SendcloudClient } from "./sendcloud/sendcloud.client";
import { SENDCLOUD_CLIENT, type SendcloudPort } from "./sendcloud/sendcloud.port";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "test" });

const SENDCLOUD = {
  publicKey: "pub",
  secretKey: "sec",
  webhookSecret: "sec",
  senderAddressId: 920582,
  mode: "test",
  baseUrl: "https://panel.sendcloud.sc/api/v3",
} as const;

describe("createSendcloudClient", () => {
  it("binds the real client when config.sendcloud is set", () => {
    const client = createSendcloudClient(SENDCLOUD, logger);
    expect(client).toBeInstanceOf(SendcloudClient);
    expect(client.isConfigured).toBe(true);
  });

  it("binds the NOT_CONFIGURED client when it is null — absent, not broken", () => {
    const client = createSendcloudClient(null, logger);
    expect(client).toBeInstanceOf(NotConfiguredSendcloudClient);
    expect(client.isConfigured).toBe(false);
  });
});

describe("NotConfiguredSendcloudClient", () => {
  const client = new NotConfiguredSendcloudClient();

  it.each([
    ["searchServicePoints", () => client.searchServicePoints()],
    ["getServicePoint", () => client.getServicePoint()],
    ["checkServicePointAvailability", () => client.checkServicePointAvailability()],
    ["listShippingOptions", () => client.listShippingOptions()],
    ["announceShipment", () => client.announceShipment()],
    ["getShipment", () => client.getShipment()],
    ["findShipmentByExternalReference", () => client.findShipmentByExternalReference()],
    ["cancelShipment", () => client.cancelShipment()],
    ["downloadLabel", () => client.downloadLabel()],
    ["getTracking", () => client.getTracking()],
  ] as const)("%s rejects with a coded FULFILMENT_NOT_CONFIGURED", async (_name, call) => {
    const error: unknown = await call().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FulfilmentError);
    expect(error).toMatchObject({ reason: "FULFILMENT_NOT_CONFIGURED", code: "CONFLICT" });
  });
});

describe("FulfilmentError", () => {
  it("is a 409 carrying the reason the envelope exposes, for not-configured", () => {
    const error = FulfilmentError.from("FULFILMENT_NOT_CONFIGURED");
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      code: "CONFLICT",
      reason: "FULFILMENT_NOT_CONFIGURED",
    });
    // The envelope's `reason` is capped at 64 chars and must fit.
    expect(
      errorEnvelopeSchema.shape.error.shape.reason.safeParse(error.reason).success,
    ).toBe(true);
  });

  it("is a 400 for the refusals the caller can fix", () => {
    expect(FulfilmentError.from("SERVICE_POINT_REQUIRED").getStatus()).toBe(400);
    expect(FulfilmentError.from("SERVICE_POINT_NOT_ALLOWED").getStatus()).toBe(400);
    expect(FulfilmentError.from("SERVICE_POINT_UNAVAILABLE").getStatus()).toBe(409);
  });
});

describe("FulfilmentModule", () => {
  async function resolveWith(env: Record<string, string>): Promise<SendcloudPort> {
    const config: ServerEnv = parseServerEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
      DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
      JWT_ACCESS_SECRET: "a".repeat(32),
      WHOP_API_KEY: "whop_test_abc123def456ghi789",
      WHOP_ACCOUNT_ID: "biz_test_1",
      WHOP_PRODUCT_ID: "prod_test_1",
      WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
      WHOP_API_VERSION_DATE: "2026-08-14",
      WHOP_ENVIRONMENT: "live",
      EMAIL_TRANSPORT: "smtp",
      SMTP_URL: "smtp://localhost:1025",
      EMAIL_FROM: "no-reply@example.com",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "akai-media",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_BUCKET_COA: "akai-coa",
      CORS_ALLOWED_ORIGINS: "http://localhost:3000",
      STOREFRONT_URL: "http://localhost:3000",
      DASHBOARD_URL: "http://localhost:3001",
      REVALIDATE_SIGNING_SECRET: "b".repeat(32),
      ...env,
    });

    const moduleRef = await Test.createTestingModule({ imports: [FulfilmentModule] })
      .useMocker((token) => {
        if (token === SERVER_CONFIG) return config;
        if (token === LOGGER) return logger;
        return undefined;
      })
      .compile();
    return moduleRef.get<SendcloudPort>(SENDCLOUD_CLIENT);
  }

  it("exports SENDCLOUD_CLIENT resolved from validated config", async () => {
    const configured = await resolveWith({
      SENDCLOUD_PUBLIC_KEY: "pub",
      SENDCLOUD_SECRET_KEY: "sec",
      SENDCLOUD_SENDER_ADDRESS_ID: "920582",
    });
    expect(configured).toBeInstanceOf(SendcloudClient);

    const absent = await resolveWith({});
    expect(absent).toBeInstanceOf(NotConfiguredSendcloudClient);
  });
});
