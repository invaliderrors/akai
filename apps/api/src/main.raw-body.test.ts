import "reflect-metadata";

import { ExpressAdapter, type NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { resetServerConfigCache } from "@akai/config";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AppModule } from "./app.module";
import { API_GLOBAL_PREFIX, RESEND_WEBHOOK_PATH } from "./common/api-paths";
import { createRawBodyMiddleware } from "./common/middleware/raw-body";
import { PrismaService } from "./modules/prisma/prisma.service";

/**
 * THE RAW-BODY MOUNT-ORDER PROOF.
 *
 * `main.ts` mounts `createRawBodyMiddleware()` on `RESEND_WEBHOOK_PATH` and does so
 * BEFORE `app.init()` registers Nest's JSON body parser, because the Resend (Svix)
 * HMAC is computed over the exact transmitted octets — a body that has been JSON-parsed and
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
 * needs no Postgres. PrismaService is stubbed only to let the full graph boot and
 * `init()` fire its module hooks without a database.
 *
 * (The Wompi event route needs no raw body — its checksum covers parsed fields —
 * so Resend is the one route this ordering protects.)
 */

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_unit",
  WOMPI_PRIVATE_KEY: "prv_test_unit",
  WOMPI_INTEGRITY_SECRET: "test_integrity_unit",
  WOMPI_EVENTS_SECRET: "test_events_unit",
  // The route under test refuses everything (503) without its secret.
  RESEND_WEBHOOK_SECRET: `whsec_${"c".repeat(32)}`,
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
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());

  if (order === "before-init") {
    // The order main.ts ships: middleware binds before init registers the JSON parser.
    app.use(RESEND_WEBHOOK_PATH, createRawBodyMiddleware());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();
  } else {
    // The regression: init first (JSON parser wins the stream), middleware after.
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();
    app.use(RESEND_WEBHOOK_PATH, createRawBodyMiddleware());
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
        .post(RESEND_WEBHOOK_PATH)
        .set("content-type", "application/json")
        .set("svix-id", "msg_forged")
        .set("svix-timestamp", String(Math.floor(Date.now() / 1000)))
        .set("svix-signature", "v1,ZGVhZGJlZWY=")
        .send({ type: "email.delivered" });

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
        .post(RESEND_WEBHOOK_PATH)
        .set("content-type", "application/json")
        .set("svix-id", "msg_forged")
        .set("svix-timestamp", String(Math.floor(Date.now() / 1000)))
        .set("svix-signature", "v1,ZGVhZGJlZWY=")
        .send({ type: "email.delivered" });

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe("RAW_BODY_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });
});
