import "reflect-metadata";

import { ExpressAdapter, type NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { resetServerConfigCache } from "@akai/config";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AppModule } from "./app.module";
import { API_GLOBAL_PREFIX, WHOP_WEBHOOK_PATH } from "./common/api-paths";
import { createRawBodyMiddleware } from "./common/middleware/raw-body";
import { WHOP_GATEWAY } from "./modules/payments/whop/whop.gateway";
import { FakeWhopGateway } from "./modules/payments/testing/fake-whop.gateway";
import { PrismaService } from "./modules/prisma/prisma.service";

/**
 * THE RAW-BODY MOUNT-ORDER PROOF.
 *
 * `main.ts` mounts `createRawBodyMiddleware()` on `WHOP_WEBHOOK_PATH` and does so
 * BEFORE `app.init()` registers Nest's JSON body parser, because the Whop HMAC is
 * computed over the exact transmitted octets — a body that has been JSON-parsed and
 * re-serialised no longer verifies. That ordering is load-bearing and was previously
 * asserted only as string-equality of two path constants (`app.module.test.ts`), which
 * cannot catch a regression that moves the `app.use` call below `init()`/`listen()`.
 *
 * These tests exercise the SAME bootstrap sequence main.ts uses, against the real
 * `AppModule` and the real webhook controller, and distinguish the two orderings by their
 * observable 400 code:
 *
 *   - mounted BEFORE init  -> raw body present  -> the controller reaches the signature
 *     check and rejects a forged signature with INVALID_SIGNATURE.
 *   - mounted AFTER init   -> the JSON parser consumed the stream first, so the middleware
 *     skips (its body-parser handshake sees `_body === true`) and no raw body is attached
 *     -> the controller fails closed with RAW_BODY_UNAVAILABLE. This is exactly the
 *     "every check green, every delivery 400s" drift the ordering exists to prevent.
 *
 * A forged (not signed) body is used deliberately: verification short-circuits at the
 * signature step, so neither ordering reaches the service or the database, and the test
 * needs no Postgres. PrismaService and the Whop gateway are stubbed only to let the full
 * graph boot and `init()` fire its module hooks without a network or a database.
 */

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_API_VERSION_DATE: "2026-08-14",
  // PINNED, as every real deployment does. NODE_ENV="test" is not production, so
  // an unset value resolves to SANDBOX and the schema then demands a sandbox
  // credential set — the parse throws and takes the whole suite with it.
  WHOP_ENVIRONMENT: "live",
  WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = process.env;
  process.env = { ...TEST_ENV };
  resetServerConfigCache();
});

afterEach(() => {
  process.env = savedEnv;
  resetServerConfigCache();
});

type MountOrder = "before-init" | "after-init";

async function buildApp(order: MountOrder): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({
      $connect: async () => undefined,
      $disconnect: async () => undefined,
      ping: async () => undefined,
    })
    // `LiveWhopGateway.onModuleInit` boot-checks the real API; `init()` below fires it.
    // Nothing on the forged-signature path calls the gateway, so the fake costs no fidelity.
    .overrideProvider(WHOP_GATEWAY)
    .useValue(new FakeWhopGateway())
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());

  if (order === "before-init") {
    // The order main.ts ships: middleware binds before init registers the JSON parser.
    app.use(WHOP_WEBHOOK_PATH, createRawBodyMiddleware());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();
  } else {
    // The regression: init first (JSON parser wins the stream), middleware after.
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();
    app.use(WHOP_WEBHOOK_PATH, createRawBodyMiddleware());
  }

  return app;
}

/**
 * The machine-readable code off an error response, PARSED.
 *
 * `supertest` types `response.body` as `any`, so `response.body.code` was an
 * unchecked member access on the one value these two tests distinguish each
 * other by. If the error envelope ever stops carrying a top-level `code`, this
 * throws at the boundary instead of comparing `undefined` and reporting a
 * confusing "expected undefined to be INVALID_SIGNATURE".
 */
const errorCodeSchema = z.object({ code: z.string() });

function errorCode(response: { readonly body: unknown }): string {
  return errorCodeSchema.parse(response.body).code;
}

describe("raw-body middleware mount order", () => {
  it("exposes the raw body when mounted BEFORE init: a forged signature reaches the signature check", async () => {
    const app = await buildApp("before-init");

    try {
      const response = await request(app.getHttpServer())
        .post(WHOP_WEBHOOK_PATH)
        .set("content-type", "application/json")
        .set("webhook-signature", "v1,ZGVhZGJlZWY=")
        .send({ type: "payment/succeeded" });

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe("INVALID_SIGNATURE");
    } finally {
      await app.close();
    }
  });

  it("400s with RAW_BODY_UNAVAILABLE when mounted AFTER init — the exact drift main.ts warns about", async () => {
    const app = await buildApp("after-init");

    try {
      const response = await request(app.getHttpServer())
        .post(WHOP_WEBHOOK_PATH)
        .set("content-type", "application/json")
        .set("webhook-signature", "v1,ZGVhZGJlZWY=")
        .send({ type: "payment/succeeded" });

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe("RAW_BODY_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });
});
